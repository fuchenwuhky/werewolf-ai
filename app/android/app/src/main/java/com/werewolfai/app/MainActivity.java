package com.werewolfai.app;

import android.content.Intent;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.BridgeActivity;

import java.io.Closeable;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Pattern;

/**
 * 硬件/手势返回接入前端返回栈（计划 §10-5）：
 * Capacitor 8 默认行为 = WebView 无历史时 moveTaskToBack，会绕过前端
 * popstate 返回栈（对局中按返回直接退到桌面）。改为先询问前端
 * window.__mwwBack()：消费则留在应用，返回 false 才最小化。
 *
 * ── 档案导出（M2-e §3.3）────────────────────────────────────────────────────────
 * 为什么走**原生桥接**而不是 Capacitor 插件：内嵌服务端起在 NodeJS 插件里之后，
 * scripts/build-app.js:71-73 会 `location.replace('http://127.0.0.1:3210/m/')` **离开** Capacitor
 * 自己那个页面；Capacitor 的插件桥属于被替换掉的页面，跳转后的页面里根本没有
 * window.Capacitor ⇒ 插件在该页面必然不可用。故用 webView.addJavascriptInterface + @JavascriptInterface。
 *
 * 注入面**只有** window.WWExport.exportProfile(profileId)（名称由计划书 §7 冻结，
 * 与 scripts/build-app.js 无关；当前 web/ 里还没有调用方，接线属下一批）。
 *   · 只导出**本机服务**的档案路径：URL 由本类自己拼（LOCAL_ORIGIN + 白名单 profileId），
 *     不接受任意 URL / 任意文件路径；调用时还要求当前页面就是本机服务的页面；
 *   · 20MiB 包体**不进 JS bridge**：原生直接 HTTP 流式读本机服务的导出接口，
 *     64KiB 一块地写进 SAF 目标，桥上来回只有一个小小的三态 JSON；
 *   · 保存位置由系统「创建文档」(ACTION_CREATE_DOCUMENT / SAF) 决定。
 *
 * release 构建 minifyEnabled false（app/android/app/build.gradle），@JavascriptInterface
 * 不会被 R8 剥掉。
 */
public class MainActivity extends BridgeActivity {

    /** 内嵌服务端固定监听的本机地址（scripts/build-app.js:69 注入 PORT=3210、:71 base 同值）。 */
    private static final String LOCAL_ORIGIN = "http://127.0.0.1:3210";
    /** 导出包上限，与 src/profiles/transfer.js 的 MAX_BYTES 一致（20 MiB）。 */
    private static final long MAX_EXPORT_BYTES = 20L * 1024 * 1024L;
    /** 与 src 侧档案 id 形态一致：只允许 [A-Za-z0-9_-]{1,64}，于是 / .. \ %2f 在拼接前就被拒。 */
    private static final Pattern PROFILE_ID = Pattern.compile("^[A-Za-z0-9_-]{1,64}$");
    /** 系统「创建文档」请求码（本应用自用，避开 Capacitor 插件占用的码段）。 */
    private static final int REQ_CREATE_DOCUMENT = 0x5757;
    private static final String BRIDGE_NAME = "WWExport";
    private static final String RESULT_CALLBACK = "__wwExportResult";
    /** 流式拷贝块大小：20MiB 全程只有这一块在内存里。 */
    private static final int STREAM_BUFFER = 64 * 1024;
    private static final int CONNECT_TIMEOUT_MS = 10000;
    private static final int READ_TIMEOUT_MS = 30000;

    private final ExecutorService exportIo = Executors.newSingleThreadExecutor();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    /** SAF 是"发起 → 用户选位置 → onActivityResult"两段式，这里记着等回调的档案 id。 */
    private String pendingProfileId = null;

    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // 注入唯一一个导出桥；名称与上面的 BRIDGE_NAME 同一常量，JS 侧引用 window.WWExport。
        WebView bridgeView = bridge != null ? bridge.getWebView() : null;
        if (bridgeView != null) {
            bridgeView.addJavascriptInterface(new ExportBridge(this), BRIDGE_NAME);
        }

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView wv = bridge != null ? bridge.getWebView() : null;
                if (wv == null) {
                    moveTaskToBack(true);
                    return;
                }
                wv.evaluateJavascript(
                    "(window.__mwwBack && window.__mwwBack()) ? 'KEEP' : 'EXIT'",
                    value -> {
                        if (value != null && value.contains("EXIT")) moveTaskToBack(true);
                    });
            }
        });
    }

    @Override
    public void onDestroy() {
        exportIo.shutdownNow();
        super.onDestroy();
    }

    /**
     * 注入到 JS 的对象，暴露面**有且只有** exportProfile 一个方法。
     *
     * ⚠ 同步返回与最终三态的关系（计划书冻结接口与 Android 现实的一处张力，详见交付报告）：
     *   @JavascriptInterface 方法的返回值是**同步**交给 JS 的，而 ACTION_CREATE_DOCUMENT 的
     *   用户选择只能在 onActivityResult 里拿到 —— "保存完成 / 用户取消" 这两个终态在**物理上**
     *   不可能同步产生。因此：
     *     · 同步返回：受理失败时就是终态三态 JSON（status=failed）；受理成功时是 {"pending":true}，
     *       因为此刻既没保存成功、也还没被取消，填任何三态值都是撒谎；
     *     · 终态三态 JSON（status ∈ saved|cancelled|failed）一律经 window.__wwExportResult(json)
     *       回调送达（受理失败时也会回调一次），JS 侧用一个 Promise 包住即可拿到最终三态。
     *   名称与方法签名与计划书冻结值逐字一致，只有"同步返回 = 终态"这一点按上述理由做了拆分。
     */
    public static final class ExportBridge {
        private final MainActivity activity;

        ExportBridge(MainActivity activity) { this.activity = activity; }

        @JavascriptInterface
        public String exportProfile(String profileId) {
            return activity.startExport(profileId);
        }
    }

    /** 受理入口（JS bridge 线程）：能同步判定的拒绝直接给终态三态，否则起 SAF 流程。 */
    private String startExport(String profileId) {
        if (profileId == null || !PROFILE_ID.matcher(profileId).matches()) {
            return reject("profileId 形态不合法（只允许 1-64 位 A-Za-z0-9_-）");
        }
        WebView wv = bridge != null ? bridge.getWebView() : null;
        if (wv == null) return reject("WebView 未就绪");
        String current = wv.getUrl();
        // 只允许本机服务的页面发起导出：跳转前还是 Capacitor 页（http://localhost）时直接拒。
        if (current == null || !current.startsWith(LOCAL_ORIGIN + "/")) {
            return reject("当前页面不是本机服务的页面，拒绝导出");
        }
        if (!claimExportSlot(profileId)) return reject("已有一次导出正在进行中");

        mainHandler.post(new Runnable() {
            @Override
            public void run() {
                try {
                    Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    intent.setType("application/json");
                    intent.putExtra(Intent.EXTRA_TITLE, "ww-profile-" + pendingProfileId + ".json");
                    startActivityForResult(intent, REQ_CREATE_DOCUMENT);
                } catch (Exception e) {
                    releaseExportSlot();
                    emitResult(failedJson(messageOf(e)));
                }
            }
        });
        return "{\"pending\":true}";
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data); // Capacitor 插件先拿（本应用未用该码）
        if (requestCode != REQ_CREATE_DOCUMENT) return;
        String profileId = releaseExportSlot();
        if (profileId == null) return;
        Uri target = (resultCode == RESULT_OK && data != null) ? data.getData() : null;
        if (target == null) {
            emitResult("{\"status\":\"cancelled\",\"pending\":false}");
            return;
        }
        final String pid = profileId;
        final Uri dest = target;
        exportIo.execute(new Runnable() {
            @Override
            public void run() {
                String json;
                try {
                    long written = streamExport(pid, dest);
                    json = "{\"status\":\"saved\",\"pending\":false,\"bytes\":" + written
                        + ",\"path\":\"" + escapeJson(dest.toString()) + "\"}";
                } catch (Exception e) {
                    json = failedJson(messageOf(e));
                }
                emitResult(json);
            }
        });
    }

    /**
     * 流式导出：从**本机服务**的导出接口读到 SAF 目标，一次一块，全程不把 20MiB 放进内存或 JS bridge。
     * @return 实际写入字节数
     */
    private long streamExport(String profileId, Uri target) throws Exception {
        HttpURLConnection conn = null;
        InputStream in = null;
        OutputStream out = null;
        try {
            URL url = new URL(LOCAL_ORIGIN + "/api/profiles/" + profileId + "/export");
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
            conn.setReadTimeout(READ_TIMEOUT_MS);
            conn.setInstanceFollowRedirects(false);
            int code = conn.getResponseCode();
            if (code != 200) throw new IllegalStateException("本机导出接口返回 " + code);
            // Content-Length 只是**提前**判据：不可信/未知（-1）时按下面的逐块累计判据兜底
            long declared = conn.getContentLength();
            if (declared > MAX_EXPORT_BYTES) throw new IllegalStateException("导出包超过 20 MiB 上限");
            in = conn.getInputStream();
            out = getContentResolver().openOutputStream(target, "w");
            if (out == null) throw new IllegalStateException("无法打开保存目标");
            byte[] buf = new byte[STREAM_BUFFER];
            long total = 0;
            int n;
            while ((n = in.read(buf)) > 0) {
                total += n;
                if (total > MAX_EXPORT_BYTES) throw new IllegalStateException("导出包超过 20 MiB 上限");
                out.write(buf, 0, n);
            }
            out.flush();
            return total;
        } finally {
            closeQuietly(in);
            closeQuietly(out);
            if (conn != null) conn.disconnect();
        }
    }

    /** 同步拒绝：三态 JSON 直接返回，同时按统一契约回调一次（JS 侧 Promise 包装不必区分两种路径）。 */
    private String reject(String message) {
        String json = failedJson(message);
        emitResult(json);
        return json;
    }

    /** 把终态三态 JSON 交给页面里的回调函数（页面可能尚未定义 ⇒ 静默忽略，但调用面只有一个名字）。 */
    private void emitResult(final String json) {
        mainHandler.post(new Runnable() {
            @Override
            public void run() {
                WebView wv = bridge != null ? bridge.getWebView() : null;
                if (wv == null) return;
                wv.evaluateJavascript(
                    "window." + RESULT_CALLBACK + " && window." + RESULT_CALLBACK + "(" + jsString(json) + ")",
                    null);
            }
        });
    }

    private synchronized boolean claimExportSlot(String profileId) {
        if (pendingProfileId != null) return false;
        pendingProfileId = profileId;
        return true;
    }

    /** 取出并清空等待中的档案 id（返回 null 表示没有等待中的导出）。 */
    private synchronized String releaseExportSlot() {
        String pid = pendingProfileId;
        pendingProfileId = null;
        return pid;
    }

    private static String failedJson(String message) {
        return "{\"status\":\"failed\",\"pending\":false,\"error\":\"" + escapeJson(message) + "\"}";
    }

    private static String messageOf(Throwable e) {
        String m = e == null ? null : e.getMessage();
        return (m == null || m.isEmpty()) ? (e == null ? "未知错误" : e.getClass().getSimpleName()) : m;
    }

    private static void closeQuietly(Closeable c) {
        if (c == null) return;
        try { c.close(); } catch (Exception ignore) { /* 关闭失败不改判结果 */ }
    }

    /** JSON 字符串转义（三态报文里可能带 content:// 路径或系统文案）。 */
    private static String escapeJson(String s) {
        if (s == null) return "";
        StringBuilder sb = new StringBuilder(s.length() + 8);
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 0x20) sb.append(String.format(Locale.US, "\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        return sb.toString();
    }

    /** JSON 串 → 可直接嵌进 evaluateJavascript 的 JS 字符串字面量（顺带挡掉 </script> 与 U+2028/2029）。 */
    private static String jsString(String s) {
        StringBuilder sb = new StringBuilder(s.length() + 8);
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                case '<': sb.append("\\u003c"); break;
                case '>': sb.append("\\u003e"); break;
                case '&': sb.append("\\u0026"); break;
                // 0x2028/0x2029 写数值字面量而不是 '\u2028'（Java 的 Unicode 转义在词法分析前展开）
                case 0x2028: sb.append("\\u2028"); break;
                case 0x2029: sb.append("\\u2029"); break;
                default:
                    if (c < 0x20) sb.append(String.format(Locale.US, "\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        sb.append('"');
        return sb.toString();
    }
}
