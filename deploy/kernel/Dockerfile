# syntax=docker/dockerfile:1
# Notebook 内核镜像：Jupyter Kernel Gateway + ipykernel + 常用科研栈。
# app 用 Docker Engine API 按项目起容器（srh-kernel-<projectId>），见 apps/server/src/modules/notebooks/kernel/host.ts。
# 容器运行时：只读根文件系统、cap-drop ALL、no-new-privileges、uid 1000、限 CPU/内存/pids、
# 只接入该项目自己的 internal 网络（没有外网、看不到数据库）；/home/jovyan/work 是项目数据卷。

FROM python:3.12-slim

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONUNBUFFERED=1 \
    MPLBACKEND=module://matplotlib_inline.backend_inline

# 中文字体（matplotlib 图里的中文标签）+ tini 作为 PID 1
RUN apt-get update \
 && apt-get install -y --no-install-recommends fonts-noto-cjk tini \
 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /tmp/requirements.txt
RUN pip install -r /tmp/requirements.txt && rm /tmp/requirements.txt

# PyTorch（CPU 版，服务器没有 GPU；CUDA 版多 3 GB 也用不上）
RUN pip install --index-url https://download.pytorch.org/whl/cpu torch torchvision torchaudio

# pip 只能经 pypi-proxy 访问 PyPI（app 注入 HTTP(S)_PROXY），默认装到 ~/.local（项目数据卷）
COPY pip.conf /etc/pip.conf
ENV PATH=/home/jovyan/work/.local/bin:$PATH

# matplotlib 默认用 Noto Sans CJK，负号正常显示；预热字体缓存到镜像里（运行时根目录只读）
COPY matplotlibrc /usr/local/etc/matplotlibrc
ENV MATPLOTLIBRC=/usr/local/etc/matplotlibrc \
    MPLCONFIGDIR=/opt/mplcache
RUN mkdir -p /opt/mplcache \
 && python -c "import matplotlib.font_manager as f; f._load_fontmanager(try_read_cache=False)" \
 && chmod -R a+rX /opt/mplcache

RUN useradd -m -u 1000 -g 100 -s /bin/bash jovyan \
 && mkdir -p /home/jovyan/work && chown 1000:100 /home/jovyan/work

# IPython 启动脚本（tqdm.auto 改用文本进度条，见 startup/00-srh-tqdm.py）。
# 运行时 IPYTHONDIR=/tmp/ipython 在 tmpfs 上、每次启动都是空的，由入口脚本复制进 profile_default/startup。
COPY startup/ /usr/local/share/srh/ipython-startup/
COPY srh-entrypoint.sh /usr/local/bin/srh-entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/srh-entrypoint.sh /usr/local/share/srh/ipython-startup/*.py \
 && chmod 755 /usr/local/bin/srh-entrypoint.sh \
 && chmod -R a+rX /usr/local/share/srh

USER 1000:100
WORKDIR /home/jovyan/work
EXPOSE 8888

# KG_AUTH_TOKEN 由 app 在建容器时注入；运行时文件全部写 /tmp（tmpfs）
ENV KG_IP=0.0.0.0 \
    KG_PORT=8888 \
    JUPYTER_RUNTIME_DIR=/tmp/jupyter-runtime \
    JUPYTER_DATA_DIR=/tmp/jupyter-data \
    IPYTHONDIR=/tmp/ipython

ENTRYPOINT ["tini", "--", "/usr/local/bin/srh-entrypoint.sh"]
CMD ["jupyter", "kernelgateway", \
     "--KernelGatewayApp.api=kernel_gateway.jupyter_websocket", \
     "--JupyterWebsocketPersonality.list_kernels=True", \
     "--KernelGatewayApp.default_kernel_name=python3"]
