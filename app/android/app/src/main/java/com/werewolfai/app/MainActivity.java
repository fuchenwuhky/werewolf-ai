package com.werewolfai.app;

import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.BridgeActivity;

/**
 * 硬件/手势返回接入前端返回栈（计划 §10-5）：
 * Capacitor 8 默认行为 = WebView 无历史时 moveTaskToBack，会绕过前端
 * popstate 返回栈（对局中按返回直接退到桌面）。改为先询问前端
 * window.__mwwBack()：消费则留在应用，返回 false 才最小化。
 */
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
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
}
