"""Embeddings for `principle` text. Runs locally (no API key), stored as float32 blobs in SQLite.

EMBEDDINGS=fastembed (default) uses a small local ONNX model, downloaded once on first use.
EMBEDDINGS=hash is a dependency-free word-hashing fallback for tests and offline use; it only
catches shared words, so do not use it for a real run. Do not mix the two in one database.
"""
import hashlib
import os
import re
import threading

import numpy as np

DIM = 384
_model = None
_lock = threading.Lock()


def _fastembed(texts):
    global _model
    with _lock:
        if _model is None:
            from fastembed import TextEmbedding
            _model = TextEmbedding(os.environ.get("EMBEDDING_MODEL", "BAAI/bge-small-en-v1.5"))
        return np.array(list(_model.embed(texts)), dtype=np.float32)


def _hash(texts):
    out = np.zeros((len(texts), DIM), dtype=np.float32)
    for i, text in enumerate(texts):
        for word in re.findall(r"[a-z]{3,}", text.lower()):
            h = int.from_bytes(hashlib.md5(word.encode()).digest()[:4], "little")
            out[i, h % DIM] += 1.0
    return out


def embed(texts):
    """Returns an (n, d) array of unit vectors."""
    vecs = _hash(texts) if os.environ.get("EMBEDDINGS", "fastembed") == "hash" else _fastembed(texts)
    norms = np.linalg.norm(vecs, axis=1, keepdims=True)
    return vecs / np.where(norms == 0, 1, norms)


def to_blob(vec):
    return np.asarray(vec, dtype=np.float32).tobytes()


def from_blob(blob):
    return np.frombuffer(blob, dtype=np.float32)
