# train-oyster.py — a nanochat-family miniature, taught this repo's prose.
#
# Byte-level GPT in the nanochat dialect: RMSNorm, rotary embeddings,
# ReLU-squared MLP, no biases, tied head. Deliberately chosen because
# these are also the *simplest* operations to hand-write in a Lisp
# that assembles itself: no means to subtract, no GELU erf, no
# positional table — just multiplies, one reciprocal square root, and
# an exp for the softmaxes.
#
# Trains on README.md + docs/wasm-macros.md (the oyster reads its own
# shell), then exports:
#   examples/oyster.npt   — weights in the .npt layout gpt.nacre reads
#   examples/oyster.test.json — a logits vector and a greedy sample,
#                               so the wasm engine can be held to it
#
#   python3 scripts/train-oyster.py            # ~3000 steps, CPU, minutes
#   STEPS=6000 python3 scripts/train-oyster.py
import json
import math
import os
import struct

import torch
import torch.nn as nn
import torch.nn.functional as F

torch.manual_seed(7)

V, D, L, H, CTX = 256, 128, 4, 4, 192
HD = D // H
STEPS = int(os.environ.get("STEPS", "3000"))
BATCH = 24
LR = 3e-4

corpus = b"".join(open(f, "rb").read() for f in ["README.md", "docs/wasm-macros.md"])
data = torch.tensor(list(corpus), dtype=torch.long)
print(f"corpus: {len(corpus)} bytes")


def rope_tables(ctx, hd):
    j = torch.arange(hd // 2, dtype=torch.float32)
    inv = 10000.0 ** (-2.0 * j / hd)
    pos = torch.arange(ctx, dtype=torch.float32)
    ang = torch.outer(pos, inv)
    return torch.cos(ang), torch.sin(ang)


COS, SIN = rope_tables(CTX, HD)


def rotate(x):  # [B, T, H, HD] with rotary over pairs (2j, 2j+1)
    T = x.shape[1]
    c, s = COS[:T], SIN[:T]
    a, b = x[..., 0::2], x[..., 1::2]
    c = c.view(1, T, 1, HD // 2)
    s = s.view(1, T, 1, HD // 2)
    out = torch.empty_like(x)
    out[..., 0::2] = a * c - b * s
    out[..., 1::2] = a * s + b * c
    return out


class RMSNorm(nn.Module):
    def __init__(self):
        super().__init__()
        self.g = nn.Parameter(torch.ones(D))

    def forward(self, x):
        return x * torch.rsqrt(x.pow(2).mean(-1, keepdim=True) + 1e-5) * self.g


class Block(nn.Module):
    def __init__(self):
        super().__init__()
        self.n1, self.n2 = RMSNorm(), RMSNorm()
        self.wq = nn.Linear(D, D, bias=False)
        self.wk = nn.Linear(D, D, bias=False)
        self.wv = nn.Linear(D, D, bias=False)
        self.wo = nn.Linear(D, D, bias=False)
        self.w1 = nn.Linear(D, 4 * D, bias=False)
        self.w2 = nn.Linear(4 * D, D, bias=False)

    def forward(self, x):
        B, T, _ = x.shape
        xn = self.n1(x)
        q = rotate(self.wq(xn).view(B, T, H, HD))
        k = rotate(self.wk(xn).view(B, T, H, HD))
        v = self.wv(xn).view(B, T, H, HD)
        att = torch.einsum("bthd,bshd->bhts", q, k) / math.sqrt(HD)
        att = att.masked_fill(torch.ones(T, T, dtype=torch.bool).triu(1), float("-inf"))
        y = torch.einsum("bhts,bshd->bthd", att.softmax(-1), v).reshape(B, T, D)
        x = x + self.wo(y)
        h = F.relu(self.w1(self.n2(x))) ** 2
        return x + self.w2(h)


class Oyster(nn.Module):
    def __init__(self):
        super().__init__()
        self.wte = nn.Embedding(V, D)
        self.blocks = nn.ModuleList(Block() for _ in range(L))
        self.nf = RMSNorm()

    def forward(self, idx):
        x = self.wte(idx)
        for b in self.blocks:
            x = b(x)
        return self.nf(x) @ self.wte.weight.T  # tied head


model = Oyster()
print(f"parameters: {sum(p.numel() for p in model.parameters())}")
opt = torch.optim.AdamW(model.parameters(), lr=LR, weight_decay=0.1)

for step in range(STEPS):
    ix = torch.randint(len(data) - CTX - 1, (BATCH,))
    xb = torch.stack([data[i : i + CTX] for i in ix])
    yb = torch.stack([data[i + 1 : i + CTX + 1] for i in ix])
    loss = F.cross_entropy(model(xb).view(-1, V), yb.view(-1))
    opt.zero_grad()
    loss.backward()
    opt.step()
    if step % 200 == 0 or step == STEPS - 1:
        print(f"step {step}: loss {loss.item():.3f}")

model.eval()

# ---- export: the .npt layout gpt.nacre reads, all f32 little-endian
def w(t):  # torch Linear stores [out, in]; the engine wants [in, out]
    return t.detach().T.contiguous().float().numpy().tobytes()


with open("examples/oyster.npt", "wb") as f:
    f.write(struct.pack("<4sIIIII", b"ngpt", V, D, L, H, CTX))
    f.write(model.wte.weight.detach().float().numpy().tobytes())
    f.write(COS.contiguous().numpy().tobytes())
    f.write(SIN.contiguous().numpy().tobytes())
    for b in model.blocks:
        f.write(b.n1.g.detach().float().numpy().tobytes())
        f.write(w(b.wq.weight))
        f.write(w(b.wk.weight))
        f.write(w(b.wv.weight))
        f.write(w(b.wo.weight))
        f.write(b.n2.g.detach().float().numpy().tobytes())
        f.write(w(b.w1.weight))
        f.write(w(b.w2.weight))
    f.write(model.nf.g.detach().float().numpy().tobytes())
print(f"examples/oyster.npt: {os.path.getsize('examples/oyster.npt')} bytes")

# ---- test vectors: hold the wasm engine to these
prompt = b"The pearl"
with torch.no_grad():
    logits = model(torch.tensor([list(prompt)]))[0, -1]
    toks = list(prompt)
    for _ in range(64):
        nxt = model(torch.tensor([toks]))[0, -1].argmax().item()
        toks.append(nxt)
greedy = bytes(toks[len(prompt):])
with open("examples/oyster.test.json", "w") as f:
    json.dump({
        "prompt": prompt.decode(),
        "logits": [float(x) for x in logits],
        "greedy": greedy.decode("utf-8", errors="replace"),
    }, f)
print("greedy sample:", repr(greedy.decode("utf-8", errors="replace")))
