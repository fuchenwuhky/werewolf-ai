#!/usr/bin/env bash
# update-app.sh — 一键更新安卓 APK：同步服务端 → cap sync → 构建 → 安装到手机
# 用法：bash scripts/update-app.sh [--no-install]   （--no-install 只构建不安装）
set -e
cd "$(dirname "$0")/.."
echo "── 1/4 同步服务端到 APP 工程 ──"
node scripts/build-app.js
cd app
echo "── 2/4 cap sync android ──"
npx cap sync android | tail -2
cd android
echo "── 3/4 构建 APK（增量） ──"
export JAVA_HOME="${JAVA_HOME:-D:\\jdk-21.0.12.1+1}"
export ANDROID_HOME="${ANDROID_HOME:-D:\\android-sdk}"
./gradlew assembleDebug --no-daemon -q
APK="app/build/outputs/apk/debug/app-debug.apk"
ls -la "$APK"
echo "── 4/4 安装到手机 ──"
if [ "$1" != "--no-install" ] && adb devices | grep -qE "\bdevice\b"; then
  adb install -r "$APK" && echo "✓ 已安装到手机"
else
  echo "（未检测到手机或指定 --no-install，跳过安装；APK 在 app/android/$APK）"
fi
echo "✓ 更新完成"
