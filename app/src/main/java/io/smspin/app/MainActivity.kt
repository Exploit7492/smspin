package io.smspin.app

import android.annotation.SuppressLint
import android.os.Bundle
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity
import org.json.JSONObject

/**
 * Multi-tenant shell: loads the tenant storefront, branded per build via
 * assets/brand.json (injected by the CI workflow). The screens are the same
 * pages served by the website, so the app stays a replica of the site.
 * Deep links of the form https://<domain>/store/<slug>/... open the store.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var web: WebView
    private val brand: JSONObject by lazy { loadBrand() }
    private val apiBase: String get() = brand.optString("apiBase", "https://smspin.io")
    private val slug: String get() = brand.optString("slug", "")

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        web = WebView(this)
        setContentView(web)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.webViewClient = WebViewClient()

        val startUrl = intent?.data?.toString()
            ?: if (slug.isNotEmpty()) "$apiBase/store/$slug/account/" else apiBase
        web.loadUrl(startUrl)
    }

    private fun loadBrand(): JSONObject = runCatching {
        assets.open("brand.json").bufferedReader().use { JSONObject(it.readText()) }
    }.getOrElse { JSONObject() }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (this::web.isInitialized && web.canGoBack()) web.goBack()
        else @Suppress("DEPRECATION") super.onBackPressed()
    }
}
