# fix-kokoro-onnx.py — one epsilon of honesty for an exported graph.
#
# Kokoro's ONNX export computes phase as atan(imag/real) with
# Where-cases — torch's atan2, unrolled. At perfectly silent frames
# the harmonic source is exactly zero (the export stripped the noise
# term), so real == imag == 0 and the division is 0/0. onnxruntime
# happens to survive because its STFT leaves ~5e-8 of float dust in
# those bins; a runtime with exact arithmetic (tract) gets honest
# zeros and honest NaN. Nudge the divisor by 1e-12: silent frames get
# phase 0, voiced frames change by nothing a float can see.
#
#   python3 scripts/fix-kokoro-onnx.py models/kokoro/onnx/model.onnx \
#     models/kokoro/onnx/model-fixed.onnx
import sys

import onnx
from onnx import helper, numpy_helper
import numpy as np

src, dst = sys.argv[1], sys.argv[2]
m = onnx.load(src, load_external_data=False)
g = m.graph

div = next(n for n in g.node if n.name == "/decoder/decoder/generator/Div")
real = div.input[1]

eps = numpy_helper.from_array(np.float32(1e-12), name="atan2_eps")
g.initializer.append(eps)
add = helper.make_node("Add", [real, "atan2_eps"], ["atan2_real_eps"], name="atan2_real_eps_add")

# rewire FIRST — protobuf extend() copies messages, so mutations
# after re-adding would hit a detached node
div.input[1] = "atan2_real_eps"

# insert before the Div, keeping topological order
nodes = list(g.node)
ix = nodes.index(div)
del g.node[:]
g.node.extend(nodes[:ix] + [add] + nodes[ix:])

onnx.save(m, dst)
print(f"wrote {dst}: Div divisor nudged by 1e-12")
