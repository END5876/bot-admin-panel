FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
# 沒有任何 npm 依賴（只用 Node 內建模組），不需要 npm ci
COPY . .
# 去掉 Windows 換行（CRLF 的 shell 腳本在 Linux 上無法執行）
RUN sed -i 's/\r$//' docker-entrypoint.sh && chmod +x docker-entrypoint.sh \
    && mkdir -p /app/data && chown node:node /app/data
# Session 金鑰、登出清單、操作紀錄的位置，部署時請把 Volume 掛載到這個目錄
ENV PANEL_DATA_DIR=/app/data
ENV ADMIN_HOST=0.0.0.0
EXPOSE 3940
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.ADMIN_PORT||3940)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# 🔒 服務本身以 node 帳號（非 root）執行：entrypoint 先修正資料目錄的擁有者再降權（見 docker-entrypoint.sh）
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "server.js"]
