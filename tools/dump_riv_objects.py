#!/usr/bin/env python3
"""Minimal .riv binary object dumper (no runtime, unnamed objects included).

Built for the Card width investigation (troubleshooting doc §12) to answer
object-level questions the JS runtime cannot (it only looks up components
BY NAME, and background shapes are typically unnamed): which object paints
what, serialized geometry, clipping shapes, parent chains.

Run:  python3 tools/dump_riv_objects.py public/assets/bench-ui.riv

Header: "RIVE" magic, varuints major/minor/fileId; ToC = varuint property
keys until 0, then a 2-bit backing-type table (4 keys per uint32, low byte).
The ToC only covers NON-core keys; classic core keys use the runtime's
static tables, reproduced (partially) in CORE_TYPES below.
Backing types: 0 = varuint, 1 = string/bytes (varuint len + payload),
2 = float32, 3 = color (4 bytes).
"""
import struct
import sys

# key -> backing type, from rive-runtime's generated core classes.
U, S, F, C = 0, 1, 2, 3
CORE_TYPES = {
    4: S,    # Component.name
    5: U,    # Component.parentId
    7: F, 8: F, 9: F, 10: F, 11: F, 12: F,   # Artboard w/h/x/y/originX/originY
    13: F, 14: F,                             # Node x/y
    15: F, 16: F, 17: F, 18: F,               # rotation/scaleX/scaleY/opacity
    20: F, 21: F,                             # ParametricPath width/height
    23: U,                                    # Drawable.blendModeValue
    24: F, 25: F, 26: F,                      # StraightVertex x/y/radius
    31: F,                                    # Rectangle cornerRadius (TL)
    32: U,                                    # PointsPath.isClosed
    33: F, 34: F, 35: F, 36: F,               # LinearGradient start/end x/y
    37: C,                                    # SolidColor.colorValue
    38: C, 39: F,                             # GradientStop color/position
    40: U, 41: U,                             # Fill.fillRule / ShapePaint.isVisible? (uint/bool)
    42: F,                                    # ??? (used near gradients: opacity?)
    44: U,                                    # Backboard.mainArtboardId?
    46: F,                                    # LinearGradient.opacity?
    47: F, 48: U, 49: U, 50: U,               # Stroke thickness/cap/join/transformAffects
    51: U,                                    # KeyedObject.objectId
    53: U, 54: U,                             # KeyedProperty.propertyKey / ?
    55: S,                                    # Animation.name
    56: U, 57: U, 58: F, 59: U, 60: U, 61: U, 62: U,  # LinearAnimation fps/duration/speed/loop/work*
    63: F, 64: F, 65: F, 66: F,               # CubicInterpolator x1/y1/x2/y2
    67: U, 68: U, 69: U,                      # KeyFrame frame/interpType/interpolatorId
    70: F,                                    # KeyFrameDouble.value
    71: U,                                    # ?
    72: U,                                    # ?
    74: F, 75: F, 76: F, 77: F,               # ?
    78: F, 79: F, 80: F, 81: F,               # CubicVertex rotations/distances
    84: F, 85: F, 86: F, 87: F,               # CubicDetachedVertex in/out rot/dist
    88: C,                                    # KeyFrameColor.value
    92: U, 93: U, 94: U,                      # ClippingShape sourceId/fillRule/isVisible
    95: U,                                    # ?
    114: U, 115: U, 116: U, 117: U,           # ListenerInputChange etc.
    119: U,                                   # ?
    121: F, 122: F, 123: F, 124: F,           # ParametricPath/vertex originX/Y etc.
    128: U,                                  # Path.pathFlags
    129: U,                                   # Drawable flags?
    130: U, 131: U,                           # ?
    138: S,                                   # StateMachineComponent.name
    139: U, 140: U, 141: U,                   # SM input values / listener ids
    142: U,                                   # ?
    144: U, 145: U,                           # ?
    149: U,                                   # AnimationState.animationId
    151: U, 152: U, 153: U, 154: U, 155: U, 156: U, 157: U, 158: U, 159: U,  # transitions/conditions
    161: F, 162: F, 163: F, 164: U,           # Rectangle cornerRadius TR/BL/BR + link (bool)
    165: F, 166: F, 167: F, 168: F, 169: F, 170: F,  # ?
    181: U, 182: U, 183: U, 184: U,           # ?
    186: U, 187: U,                           # ?
}

data = open(sys.argv[1], 'rb').read()
pos = 0

def varuint():
    global pos
    result = 0
    shift = 0
    while True:
        b = data[pos]; pos += 1
        result |= (b & 0x7F) << shift
        if not (b & 0x80):
            return result
        shift += 7

assert data[:4] == b'RIVE', 'not a riv'
pos = 4
major = varuint(); minor = varuint(); file_id = varuint()

toc_keys = []
while True:
    k = varuint()
    if k == 0:
        break
    toc_keys.append(k)

field_types = dict(CORE_TYPES)
current_int = 0
current_bit = 8
for k in toc_keys:
    if current_bit == 8:
        current_int = struct.unpack_from('<I', data, pos)[0]; pos += 4
        current_bit = 0
    field_types[k] = (current_int >> current_bit) & 3
    current_bit += 2

print(f'riv {major}.{minor} tocKeys={len(toc_keys)} streamBytes={len(data)}', file=sys.stderr)

TYPE_NAMES = {
    1: 'Artboard', 2: 'Node', 3: 'Shape', 4: 'Ellipse', 5: 'StraightVertex',
    6: 'CubicDetachedVertex', 7: 'Rectangle', 16: 'PointsPath',
    17: 'RadialGradient', 18: 'SolidColor', 19: 'GradientStop', 20: 'Fill',
    22: 'LinearGradient', 23: 'Backboard', 24: 'Stroke', 25: 'KeyedObject',
    26: 'KeyedProperty', 28: 'KeyFrameDouble', 30: 'KeyFrameColor',
    31: 'LinearAnimation', 34: 'CubicEase', 35: 'CubicAsymmetricVertex',
    37: 'KeyFrameId', 42: 'ClippingShape', 53: 'StateMachine',
    56: 'StateMachineLayer', 57: 'AnimationState', 58: 'StateMachineTrigger',
    59: 'StateMachineBool', 60: 'StateMachineNumber', 62: 'EntryState',
    63: 'ExitState', 64: 'AnyState', 65: 'StateTransition',
    105: 'ImageAsset', 106: 'FileAssetContents', 134: 'Text',
    135: 'TextValueRun', 137: 'TextStylePaint', 141: 'FontAsset',
}
PROP_NAMES = {
    4: 'name', 5: 'parent', 7: 'width', 8: 'height', 9: 'x', 10: 'y',
    11: 'originX', 12: 'originY', 13: 'x', 14: 'y', 15: 'rot', 16: 'scaleX',
    17: 'scaleY', 18: 'opacity', 20: 'w', 21: 'h', 23: 'blend',
    24: 'vx', 25: 'vy', 26: 'vRadius', 31: 'radTL', 37: 'color', 38: 'color',
    39: 'pos', 41: 'visible', 47: 'thickness', 51: 'objectId',
    53: 'propKey', 55: 'name', 67: 'frame', 70: 'value',
    92: 'clipSource', 93: 'clipRule', 94: 'clipVisible',
    138: 'name', 149: 'animId', 151: 'toId', 161: 'radTR', 162: 'radBL',
    163: 'radBR', 164: 'linkRad', 203: 'assetName', 268: 'text',
}

objects = []
try:
    while pos < len(data):
        at = pos
        type_key = varuint()
        props = {}
        while True:
            prop_key = varuint()
            if prop_key == 0:
                break
            if prop_key not in field_types:
                raise ValueError(f'unknown prop key {prop_key} (object type {type_key}, object at byte {at}, key at ~{pos})')
            ft = field_types[prop_key]
            if ft == U:
                value = varuint()
            elif ft == S:
                length = varuint()
                raw = data[pos:pos + length]; pos += length
                try:
                    value = raw.decode('utf-8')
                    if len(value) > 60:
                        value = f'<{length} bytes>'
                except UnicodeDecodeError:
                    value = f'<{length} bytes>'
            elif ft == F:
                value = struct.unpack_from('<f', data, pos)[0]; pos += 4
            else:
                value = '#%08X' % struct.unpack_from('<I', data, pos)[0]; pos += 4
            props[prop_key] = value
        objects.append((at, type_key, props))
except ValueError as error:
    print(f'!! {error} — dumping what parsed', file=sys.stderr)

print(f'objects={len(objects)}', file=sys.stderr)

component_index = 0
in_artboard = False
for at, type_key, props in objects:
    tname = TYPE_NAMES.get(type_key, f'type{type_key}')
    pretty = []
    for k, v in props.items():
        label = PROP_NAMES.get(k, f'k{k}')
        if isinstance(v, float):
            v = round(v, 2)
        pretty.append(f'{label}={v}')
    line = f'{tname:22s} ' + ' '.join(pretty)
    if type_key == 1:
        component_index = 0
        in_artboard = True
        print(f'\n=== [{component_index}] ARTBOARD {line}')
        component_index = 1
    elif type_key in (25, 26, 28, 30, 34, 37):
        pass  # keyframe noise — animations summarized by name only
    elif type_key == 31:
        print(f'  ---- animation: {props.get(55, "?")}')
    elif type_key in (53, 56, 57, 58, 59, 60, 62, 63, 64, 65):
        if type_key in (53,):
            print(f'  ---- state machine: {props.get(138, "?")}')
    elif in_artboard:
        print(f'  [{component_index:3d}] {line}')
        component_index += 1
    else:
        print(f'  (pre) {line}')
