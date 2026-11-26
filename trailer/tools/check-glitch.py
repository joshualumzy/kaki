#!/usr/bin/env python3
"""Fail loudly if a rendered film has a one-frame glitch: a frame unlike both neighbours while they match each other
(seen in v10.7: Chrome occasionally paints the cafe as a tiled pattern for one frame). Usage: check-glitch.py film.mp4"""
import subprocess, sys
W, H = 96, 54
raw = subprocess.run(['ffmpeg', '-loglevel', 'error', '-i', sys.argv[1], '-vf', f'scale={W}:{H},format=gray', '-f', 'rawvideo', '-'], capture_output=True, check=True).stdout
n = W * H; F = [raw[i:i + n] for i in range(0, len(raw), n)]
df = lambda a, b: sum(abs(x - y) for x, y in zip(a, b)) / n
bad = [k for k in range(1, len(F) - 1) if min(df(F[k - 1], F[k]), df(F[k], F[k + 1])) > 6 and df(F[k - 1], F[k + 1]) < min(df(F[k - 1], F[k]), df(F[k], F[k + 1])) / 3]
if len(F) > 2 and df(F[0], F[1]) > 6 and df(F[1], F[2]) < 2: bad.insert(0, 0)
if bad: sys.exit(f'GLITCH frames {bad}: re-render those frames before using this film')
print(f'clean: {len(F)} frames')
