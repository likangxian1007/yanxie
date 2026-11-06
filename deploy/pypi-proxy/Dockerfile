# Notebook 内核的 pip 出网代理：只放行 PyPI（白名单见 filter），其他域名一律 403。
# 内核网络仍是 internal（没有默认路由）；app 起内核时把本容器接入该项目的内核网络（别名 pypi-proxy），
# 并给内核注入 HTTP(S)_PROXY=http://pypi-proxy:3128。见 apps/server/src/modules/notebooks/kernel/host.ts。
FROM alpine:3.22
RUN apk add --no-cache tinyproxy
COPY tinyproxy.conf /etc/tinyproxy/tinyproxy.conf
COPY filter /etc/tinyproxy/filter
RUN sed -i 's/\r$//' /etc/tinyproxy/tinyproxy.conf /etc/tinyproxy/filter
USER tinyproxy
EXPOSE 3128
CMD ["tinyproxy", "-d", "-c", "/etc/tinyproxy/tinyproxy.conf"]
