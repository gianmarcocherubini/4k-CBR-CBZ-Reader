#!/usr/bin/env python3
"""
Converts the official Real-ESRGAN "realesr-animevideov3" checkpoint (SRVGGNetCompact, BSD-3-Clause,
https://github.com/xinntao/Real-ESRGAN) into the compact FP16 weight file read by
src/lib/upscale/esrgan/weights.ts. No PyTorch needed: the .pth zip is unpickled with numpy only.

Usage:
  curl -L -o /tmp/realesr-animevideov3.pth \
    https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesr-animevideov3.pth
  python3 scripts/convert-realesr-weights.py /tmp/realesr-animevideov3.pth \
    src/lib/upscale/esrgan/realesr-animevideov3.f16.bin

File layout (little endian):
  "SRVG" | u32 header length | JSON header | zero padding to 8 bytes | f16 tensor data
Convolution weights are stored as [ky][kx][cin][cout] so a shader reads, for one input tap and
one input channel, all output channels contiguously.
"""
import collections
import hashlib
import json
import pickle
import struct
import sys
import zipfile

import numpy as np


class _Storage:
    def __init__(self, key, dtype):
        self.key = key
        self.dtype = dtype


def load_state_dict(path):
    z = zipfile.ZipFile(path)
    prefix = z.namelist()[0].split('/')[0] + '/'

    def rebuild(storage, offset, size, stride, *_rest):
        raw = z.read(f'{prefix}data/{storage.key}')
        arr = np.frombuffer(raw, dtype=storage.dtype)
        n = int(np.prod(size)) if len(size) else 1
        expected = []
        s = 1
        for d in reversed(size):
            expected.insert(0, s)
            s *= d
        if tuple(stride) != tuple(expected):
            raise ValueError(f'non-contiguous tensor {size} {stride}')
        return arr[offset:offset + n].reshape(size).astype(np.float32)

    class Unpickler(pickle.Unpickler):
        def find_class(self, module, name):
            if name == '_rebuild_tensor_v2':
                return rebuild
            if name == 'FloatStorage':
                return 'f4'
            if name == 'HalfStorage':
                return 'f2'
            if name == 'OrderedDict':
                return collections.OrderedDict
            raise pickle.UnpicklingError(f'unexpected {module}.{name}')

        def persistent_load(self, pid):
            _typ, dtype, key, _loc, _numel = pid
            return _Storage(key, np.dtype(dtype))

    obj = Unpickler(z.open(f'{prefix}data.pkl')).load()
    return obj.get('params_ema') or obj.get('params') or obj


def main(src, dst):
    sd = load_state_dict(src)
    keys = list(sd.keys())
    convs = sorted({int(k.split('.')[1]) for k in keys if k.endswith('.bias')})
    first, last = convs[0], convs[-1]
    body = convs[1:-1]
    num_feat = int(sd[f'body.{first}.weight'].shape[0])
    cout_last = int(sd[f'body.{last}.weight'].shape[0])
    upscale = int(round((cout_last / 3) ** 0.5))
    if upscale * upscale * 3 != cout_last:
        raise ValueError(f'unexpected conv_last shape {sd[f"body.{last}.weight"].shape}')

    chunks = []
    layers = []
    cursor = [0]

    def put(arr):
        arr16 = np.ascontiguousarray(arr, dtype=np.float32).astype(np.float16)
        if not np.all(np.isfinite(arr16)):
            raise ValueError('value out of the FP16 range')
        ref = {'offset': cursor[0], 'count': int(arr16.size)}
        cursor[0] += int(arr16.size)
        chunks.append(arr16.tobytes())
        return ref

    def conv(index, name, prelu_index):
        w = sd[f'body.{index}.weight']  # (cout, cin, ky, kx)
        b = sd[f'body.{index}.bias']
        cout, cin = int(w.shape[0]), int(w.shape[1])
        layer = {
            'name': name,
            'cin': cin,
            'cout': cout,
            'weight': put(w.transpose(2, 3, 1, 0)),  # (ky, kx, cin, cout)
            'bias': put(b),
        }
        if prelu_index is not None:
            layer['prelu'] = put(sd[f'body.{prelu_index}.weight'])
        layers.append(layer)

    conv(first, 'conv_first', first + 1)
    for i, index in enumerate(body):
        conv(index, f'body.{i}', index + 1)
    conv(last, 'conv_last', None)

    with open(src, 'rb') as f:
        sha = hashlib.sha256(f.read()).hexdigest()
    header = {
        'arch': 'srvgg',
        'model': 'realesr-animevideov3',
        'source': 'Real-ESRGAN v0.2.5.0 realesr-animevideov3.pth (BSD-3-Clause, Xintao Wang et al.)',
        'sourceSha256': sha,
        'numFeat': num_feat,
        'numConv': len(body),
        'upscale': upscale,
        'dtype': 'f16',
        'weightLayout': 'ky,kx,cin,cout',
        'layers': layers,
    }
    header_bytes = json.dumps(header, separators=(',', ':')).encode('utf-8')
    prefix = b'SRVG' + struct.pack('<I', len(header_bytes)) + header_bytes
    padding = (-len(prefix)) % 8
    data = b''.join(chunks)
    with open(dst, 'wb') as f:
        f.write(prefix + b'\0' * padding + data)
    print(f'{dst}: {len(layers)} layers, {cursor[0]} parameters, {len(prefix) + padding + len(data)} bytes')


if __name__ == '__main__':
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(2)
    main(sys.argv[1], sys.argv[2])
