/// <reference lib="webworker" />
/// <reference types="@webgpu/types" />
import type { InferenceSession, Tensor } from 'onnxruntime-web'
import type { HeavyFactor, ModelSpec } from './protocol'

type Ort = typeof import('onnxruntime-web')

const PREPROCESS_WGSL = /* wgsl */ `
struct Params {
  x0: u32,
  y0: u32,
  padW: u32,
  tile: u32,
}

@group(0) @binding(0) var<storage, read> source: array<u32>;
@group(0) @binding(1) var<storage, read_write> input: array<f32>;
@group(0) @binding(2) var<uniform> params: Params;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= params.tile || gid.y >= params.tile) {
    return;
  }
  let rgba = source[(params.y0 + gid.y) * params.padW + params.x0 + gid.x];
  let p = gid.y * params.tile + gid.x;
  let plane = params.tile * params.tile;
  input[p] = f32(rgba & 255u) / 255.0;
  input[plane + p] = f32((rgba >> 8u) & 255u) / 255.0;
  input[2u * plane + p] = f32((rgba >> 16u) & 255u) / 255.0;
}
`

const STITCH_WGSL = /* wgsl */ `
struct Params {
  ox0: u32,
  oy0: u32,
  outW: u32,
  outH: u32,
  outTile: u32,
  outEdge: u32,
  validOff: u32,
  sub: u32,
  gray: u32,
  single: u32,
  color: u32,
  pad: u32,
}

@group(0) @binding(0) var<storage, read> network: array<f32>;
@group(0) @binding(1) var<storage, read_write> page: array<u32>;
@group(0) @binding(2) var<uniform> params: Params;

fn byteFromFloat(v: f32) -> u32 {
  let x = clamp(v * 255.0, 0.0, 255.0);
  let lo = floor(x);
  let frac = x - lo;
  var n = u32(lo);
  // Uint8ClampedArray uses ties-to-even (ECMAScript ToUint8Clamp).
  if (frac > 0.5 || (frac == 0.5 && (n & 1u) == 1u)) {
    n += 1u;
  }
  return n;
}

fn sample(channel: u32, x: u32, y: u32) -> f32 {
  let plane = params.outEdge * params.outEdge;
  if (params.sub == 1u) {
    return network[channel * plane + (params.validOff + y) * params.outEdge + params.validOff + x];
  }
  var sum = 0.0;
  for (var sy = 0u; sy < params.sub; sy += 1u) {
    for (var sx = 0u; sx < params.sub; sx += 1u) {
      let p = (params.validOff + y * params.sub + sy) * params.outEdge +
        params.validOff + x * params.sub + sx;
      sum += network[channel * plane + p];
    }
  }
  return sum / f32(params.sub * params.sub);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= params.outTile || gid.y >= params.outTile) {
    return;
  }
  let ox = params.ox0 + gid.x;
  let oy = params.oy0 + gid.y;
  if (ox >= params.outW || oy >= params.outH) {
    return;
  }
  if (params.single == 1u) {
    page[oy * params.outW + ox] = params.color;
    return;
  }
  var r = sample(0u, gid.x, gid.y);
  var g = sample(1u, gid.x, gid.y);
  var b = sample(2u, gid.x, gid.y);
  if (params.gray == 1u) {
    let l = (r + g + b) / 3.0;
    r = l;
    g = l;
    b = l;
  }
  page[oy * params.outW + ox] =
    byteFromFloat(r) |
    (byteFromFloat(g) << 8u) |
    (byteFromFloat(b) << 16u) |
    0xff000000u;
}
`

const align4 = (n: number): number => Math.ceil(n / 4) * 4

/** Returns the packed RGBA colour when a tile is constant, otherwise null. */
function singleColour(padded: Uint8ClampedArray, padW: number, x0: number, y0: number, tile: number): number | null {
  const first = (y0 * padW + x0) * 4
  const r = padded[first]!
  const g = padded[first + 1]!
  const b = padded[first + 2]!
  for (let y = 0; y < tile; y++) {
    let p = ((y0 + y) * padW + x0) * 4
    for (let x = 0; x < tile; x++, p += 4) {
      if (padded[p] !== r || padded[p + 1] !== g || padded[p + 2] !== b) return null
    }
  }
  return (r | (g << 8) | (b << 16) | 0xff000000) >>> 0
}

function toGrayColour(rgba: number): number {
  const r = rgba & 255
  const g = (rgba >>> 8) & 255
  const b = (rgba >>> 16) & 255
  // The sum divided by three can only have .0/.333/.667, so Math.round equals ToUint8Clamp.
  const l = Math.round((r + g + b) / 3)
  return (l | (l << 8) | (l << 16) | 0xff000000) >>> 0
}

/**
 * Real-ESRGAN tile runner that keeps model I/O and page stitching on the same WebGPU device used
 * by ONNX Runtime. Input/output buffers are fixed, allowing ORT graph capture; one RGBA page buffer
 * is read back after every tile has been inferred and stitched.
 */
export class GpuTileRunner {
  private readonly session: InferenceSession
  private readonly device: GPUDevice
  private readonly spec: ModelSpec
  private readonly inputBuffer: GPUBuffer
  private readonly modelOutputBuffer: GPUBuffer
  private readonly inputTensor: Tensor
  private readonly outputTensor: Tensor
  private readonly preprocessParams: GPUBuffer
  private readonly stitchParams: GPUBuffer
  private readonly preprocessPipeline: GPUComputePipeline
  private readonly stitchPipeline: GPUComputePipeline

  private constructor(
    ort: Ort,
    session: InferenceSession,
    device: GPUDevice,
    spec: ModelSpec,
    preprocessPipeline: GPUComputePipeline,
    stitchPipeline: GPUComputePipeline,
  ) {
    this.session = session
    this.device = device
    this.spec = spec
    const outEdge = spec.scale * spec.tile - spec.shrink
    this.inputBuffer = device.createBuffer({
      label: 'Real-ESRGAN tile input',
      size: 3 * spec.tile * spec.tile * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    })
    this.modelOutputBuffer = device.createBuffer({
      label: 'Real-ESRGAN tile output',
      size: 3 * outEdge * outEdge * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    })
    this.inputTensor = ort.Tensor.fromGpuBuffer(this.inputBuffer, {
      dataType: 'float32',
      dims: [1, 3, spec.tile, spec.tile],
    })
    this.outputTensor = ort.Tensor.fromGpuBuffer(this.modelOutputBuffer, {
      dataType: 'float32',
      dims: [1, 3, outEdge, outEdge],
    })
    this.preprocessParams = device.createBuffer({
      label: 'Real-ESRGAN preprocess params',
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    this.stitchParams = device.createBuffer({
      label: 'Real-ESRGAN stitch params',
      size: 48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    this.preprocessPipeline = preprocessPipeline
    this.stitchPipeline = stitchPipeline
  }

  static async create(ort: Ort, session: InferenceSession, device: GPUDevice, spec: ModelSpec): Promise<GpuTileRunner> {
    if (spec.id !== 'esrgan6b') throw new Error('GPU tile runner supports Real-ESRGAN only')
    const [preprocessPipeline, stitchPipeline] = await Promise.all([
      device.createComputePipelineAsync({
        label: 'Real-ESRGAN RGBA to NCHW',
        layout: 'auto',
        compute: { module: device.createShaderModule({ code: PREPROCESS_WGSL }), entryPoint: 'main' },
      }),
      device.createComputePipelineAsync({
        label: 'Real-ESRGAN stitch to RGBA',
        layout: 'auto',
        compute: { module: device.createShaderModule({ code: STITCH_WGSL }), entryPoint: 'main' },
      }),
    ])
    return new GpuTileRunner(ort, session, device, spec, preprocessPipeline, stitchPipeline)
  }

  async run(
    padded: Uint8ClampedArray,
    padW: number,
    width: number,
    height: number,
    blocksW: number,
    blocksH: number,
    cropIn: number,
    step: number,
    gray: boolean,
    outFactor: HeavyFactor,
    cancelled: () => boolean,
    onTile: () => void,
  ): Promise<ImageData> {
    const { device, spec } = this
    const outW = width * outFactor
    const outH = height * outFactor
    const outTile = step * outFactor
    const outEdge = spec.scale * spec.tile - spec.shrink
    const validOff = spec.scale * cropIn - spec.shrink / 2
    const sub = spec.scale / outFactor
    const sourceBuffer = device.createBuffer({
      label: 'Real-ESRGAN padded source',
      size: align4(padded.byteLength),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    })
    const pageBuffer = device.createBuffer({
      label: 'Real-ESRGAN fitted page',
      size: outW * outH * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    })
    const outBytes = outW * outH * 4
    const readBuffer = device.createBuffer({
      label: 'Real-ESRGAN page readback',
      size: outBytes,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    })
    device.queue.writeBuffer(sourceBuffer, 0, padded)
    const preprocessBindGroup = device.createBindGroup({
      layout: this.preprocessPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: sourceBuffer } },
        { binding: 1, resource: { buffer: this.inputBuffer } },
        { binding: 2, resource: { buffer: this.preprocessParams } },
      ],
    })
    const stitchBindGroup = device.createBindGroup({
      layout: this.stitchPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.modelOutputBuffer } },
        { binding: 1, resource: { buffer: pageBuffer } },
        { binding: 2, resource: { buffer: this.stitchParams } },
      ],
    })
    try {
      for (let bi = 0; bi < blocksH; bi++) {
        for (let bj = 0; bj < blocksW; bj++) {
          if (cancelled()) throw Object.assign(new Error('Annullato'), { code: 'aborted' })
          const x0 = bj * step
          const y0 = bi * step
          const sourceColour = singleColour(padded, padW, x0, y0, spec.tile)
          const colour = sourceColour !== null && gray ? toGrayColour(sourceColour) : sourceColour
          if (colour === null) {
            device.queue.writeBuffer(this.preprocessParams, 0, new Uint32Array([x0, y0, padW, spec.tile]))
            const encoder = device.createCommandEncoder({ label: 'Real-ESRGAN preprocess' })
            const pass = encoder.beginComputePass()
            pass.setPipeline(this.preprocessPipeline)
            pass.setBindGroup(0, preprocessBindGroup)
            pass.dispatchWorkgroups(Math.ceil(spec.tile / 8), Math.ceil(spec.tile / 8))
            pass.end()
            device.queue.submit([encoder.finish()])
            await this.session.run(
              { [this.session.inputNames[0]!]: this.inputTensor },
              { [this.session.outputNames[0]!]: this.outputTensor },
            )
          }
          device.queue.writeBuffer(
            this.stitchParams,
            0,
            new Uint32Array([
              bj * outTile,
              bi * outTile,
              outW,
              outH,
              outTile,
              outEdge,
              validOff,
              sub,
              gray ? 1 : 0,
              colour === null ? 0 : 1,
              colour ?? 0,
              0,
            ]),
          )
          const encoder = device.createCommandEncoder({ label: 'Real-ESRGAN stitch' })
          const pass = encoder.beginComputePass()
          pass.setPipeline(this.stitchPipeline)
          pass.setBindGroup(0, stitchBindGroup)
          pass.dispatchWorkgroups(Math.ceil(outTile / 8), Math.ceil(outTile / 8))
          pass.end()
          device.queue.submit([encoder.finish()])
          onTile()
        }
      }
      // One map is materially faster than chunked maps on current WebGPU implementations. The
      // FP16 graph halves model/intermediate memory, leaving room for this ≤64 MiB staging buffer.
      const encoder = device.createCommandEncoder({ label: 'Real-ESRGAN final readback' })
      encoder.copyBufferToBuffer(pageBuffer, 0, readBuffer, 0, outBytes)
      device.queue.submit([encoder.finish()])
      await readBuffer.mapAsync(GPUMapMode.READ)
      const out = new Uint8ClampedArray(readBuffer.getMappedRange().slice(0))
      readBuffer.unmap()
      return new ImageData(out, outW, outH)
    } finally {
      sourceBuffer.destroy()
      pageBuffer.destroy()
      readBuffer.destroy()
    }
  }

  dispose(): void {
    this.inputTensor.dispose()
    this.outputTensor.dispose()
    this.inputBuffer.destroy()
    this.modelOutputBuffer.destroy()
    this.preprocessParams.destroy()
    this.stitchParams.destroy()
  }
}
