# Sandbox image for NANOCODE_SANDBOX=docker. Deliberately minimal: the nanocode_kernel package's
# own Python source is bind-mounted read-only at container-start time by ReplKernelManager
# (packages/kernel/src/repl-kernel-manager.ts's buildSpawnCommand), not baked in here -- so this
# image only ever needs Python 3.11+ and dill (used for snapshot/restore) and never needs
# rebuilding when kernel source changes.
#
# Build once with:
#   docker build -t nanocode-kernel:latest packages/kernel/docker
# then run any CLI command with NANOCODE_SANDBOX=docker to route kernel execution through it.
FROM python:3.11-slim

RUN pip install --no-cache-dir dill
