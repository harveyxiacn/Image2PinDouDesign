@echo off
rem 拼豆仓 Hub 一键启动：首次运行会安装依赖并构建界面，然后在局域网 8787 端口提供服务。
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul || (echo 需要先安装 Node.js 22.13 或更新版本：https://nodejs.org & pause & exit /b 1)
if not exist node_modules (
  echo 正在安装依赖…
  call npm install --no-audit --no-fund || (pause & exit /b 1)
)
if not exist dist\index.html (
  echo 正在构建界面…
  call npm run build || (pause & exit /b 1)
)
node server\hub.mjs %*
pause
