package io.smspin.app

import android.annotation.SuppressLint
import android.os.Bundle
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity
import org.json.JSONObject

/**
 * Multi-tenant shell: loads the tenant storefront, branded per build via
 * BuildConfig.BRAND_JSON (injected by the CI workflow). Deep links of the form
 * https://<domain>/store/<slug>/... open the matching store.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var web: WebView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val brand = runCatching { JSONObject(BuildConfig.BRAND_JSON) }.getOrElse { JSONObject() }
        val apiBase = brand.optString("apiBase", "https://smspin.io")
        val slug = brand.optString("slug", "")

        web = WebView(this)
        setContentView(web)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.webViewClient = WebViewClient()

        val startUrl = intent?.data?.toString()
            ?: if (slug.isNotEmpty()) "$apiBase/store/$slug/account/" else apiBase
        web.loadUrl(startUrl)
    }

    override fun onBackPressed() {
        if (this::web.isInitialized && web.canGoBack()) web.goBack() else super.onBackPressed()
    }
}
