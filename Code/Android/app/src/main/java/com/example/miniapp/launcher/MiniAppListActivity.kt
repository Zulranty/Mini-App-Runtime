package com.example.miniapp.launcher

import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.Space
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.app.AppCompatDelegate
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.recyclerview.widget.GridLayoutManager
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.example.miniapp.installer.MiniAppInstaller
import com.example.miniapp.model.InstalledMiniApp
import com.example.miniapp.repository.MiniAppRepository
import com.example.miniapp.repository.SharedMiniAppStore
import com.example.miniapp.runtime.MiniAppActivity
import java.io.File
import kotlin.concurrent.thread

private class LauncherPrefs(context: Context) {
    private val prefs = context.getSharedPreferences("launcher", Context.MODE_PRIVATE)

    var grid: Boolean
        get() = prefs.getBoolean("grid", false)
        set(value) = prefs.edit().putBoolean("grid", value).apply()

    var sort: String
        get() = prefs.getString("sort", "name") ?: "name"
        set(value) = prefs.edit().putString("sort", value).apply()

    var sortDesc: Boolean
        get() = prefs.getBoolean("sort_desc", false)
        set(value) = prefs.edit().putBoolean("sort_desc", value).apply()

    var theme: String
        get() = prefs.getString("theme", "system") ?: "system"
        set(value) = prefs.edit().putString("theme", value).apply()

    var accent: Int
        get() = prefs.getInt("accent", Color.rgb(54, 91, 255))
        set(value) = prefs.edit().putInt("accent", value).apply()
}

class MiniAppListActivity : AppCompatActivity() {
    private val repo by lazy { MiniAppRepository(this) }
    private val prefs by lazy { LauncherPrefs(this) }
    private lateinit var list: RecyclerView
    private lateinit var empty: TextView
    private lateinit var root: LinearLayout
    private val skippedUnknownHtml = mutableSetOf<String>()
    private var htmlDialogShowing = false

    private val picker = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        uri ?: return@registerForActivityResult
        thread {
            try {
                val tmp = File(cacheDir, "import.zip")
                contentResolver.openInputStream(uri)!!.use { input ->
                    tmp.outputStream().use { output -> input.copyTo(output) }
                }
                val manifest = MiniAppInstaller(this).install(tmp).manifest
                tmp.delete()
                runOnUiThread {
                    toast("Установлено: ${manifest.name}")
                    reload()
                }
            } catch (e: Exception) {
                runOnUiThread { toast(e.message ?: "Ошибка импорта") }
            }
        }
    }

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        applyTheme()
        buildUi()
        ensureSharedFolderAccess()
        reload()
    }

    override fun onResume() {
        super.onResume()
        if (::list.isInitialized) reload()
    }

    private fun applyTheme() {
        AppCompatDelegate.setDefaultNightMode(
            when (prefs.theme) {
                "light" -> AppCompatDelegate.MODE_NIGHT_NO
                "dark" -> AppCompatDelegate.MODE_NIGHT_YES
                else -> AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM
            }
        )
    }

    private fun buildUi() {
        val dark = resources.configuration.uiMode and 0x30 == 0x20
        val background = if (dark) Color.rgb(18, 20, 28) else Color.rgb(247, 248, 252)
        val foreground = if (dark) Color.WHITE else Color.rgb(27, 30, 38)
        val side = dp(16)
        val top = dp(18)
        val bottomPadding = dp(12)

        root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(background)
            setPadding(side, top, side, bottomPadding)
        }
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            view.setPadding(side, top + bars.top, side, bottomPadding + bars.bottom)
            insets
        }

        root.addView(Space(this), LinearLayout.LayoutParams(-1, dp(28)))

        empty = TextView(this).apply {
            text = "Мини-приложения не установлены\n\nИмпортируйте ZIP-архив, чтобы начать"
            gravity = Gravity.CENTER
            textSize = 17f
            setTextColor(foreground)
        }
        list = RecyclerView(this).apply {
            setBackgroundColor(Color.TRANSPARENT)
            clipToPadding = false
            setPadding(0, 0, 0, dp(12))
        }
        root.addView(empty, LinearLayout.LayoutParams(-1, 0, 1f))
        root.addView(list, LinearLayout.LayoutParams(-1, 0, 1f))

        val bottom = LinearLayout(this).apply {
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, dp(8), 0, 0)
        }
        bottom.addView(
            Button(this).apply {
                text = "Импорт ZIP"
                setTextColor(Color.WHITE)
                setBackgroundColor(prefs.accent)
                setOnClickListener { picker.launch(arrayOf("application/zip", "application/octet-stream")) }
            },
            LinearLayout.LayoutParams(0, dp(52), 1f)
        )
        bottom.addView(
            ImageButton(this).apply {
                contentDescription = "Настройки"
                setImageResource(android.R.drawable.ic_menu_manage)
                setColorFilter(foreground)
                setBackgroundColor(Color.TRANSPARENT)
                setOnClickListener { showSettings() }
            },
            LinearLayout.LayoutParams(dp(56), dp(52)).apply { setMargins(dp(12), 0, 0, 0) }
        )
        root.addView(bottom, LinearLayout.LayoutParams(-1, -2))

        setContentView(root)
        ViewCompat.requestApplyInsets(root)
    }

    private fun reload() {
        if (SharedMiniAppStore.hasFileAccess()) {
            runCatching { repo.sync() }.onFailure { toast(it.message ?: "Ошибка чтения MiniApps") }
        }
        val sorted = repo.list().let { apps ->
            when (prefs.sort) {
                "version" -> apps.sortedBy { it.manifest.version.lowercase() }
                else -> apps.sortedBy { it.manifest.name.lowercase() }
            }
        }
        val apps = if (prefs.sortDesc) sorted.asReversed() else sorted
        val hasApps = apps.isNotEmpty()
        empty.visibility = if (hasApps) View.GONE else View.VISIBLE
        list.visibility = if (hasApps) View.VISIBLE else View.GONE

        val widthDp = resources.configuration.screenWidthDp
        val columns = when {
            widthDp >= 720 -> 4
            widthDp >= 480 -> 3
            widthDp >= 360 -> 2
            else -> 1
        }
        list.layoutManager = if (prefs.grid) GridLayoutManager(this, columns) else LinearLayoutManager(this)
        list.adapter = MiniAppAdapter(
            items = apps,
            grid = prefs.grid,
            accent = prefs.accent,
            iconFile = { app -> File(repo.dir(app.manifest.id), app.manifest.icon ?: "__missing_icon__") },
            launch = { app -> startActivity(Intent(this, MiniAppActivity::class.java).putExtra("appId", app.manifest.id)) },
            menu = { app -> showMenu(app) }
        )
        showUnknownHtmlPrompt()
    }

    private fun showUnknownHtmlPrompt() {
        if (!SharedMiniAppStore.hasFileAccess() || htmlDialogShowing) return
        val html = SharedMiniAppStore.htmlFilesWithoutManifest()
            .firstOrNull { it.absolutePath !in skippedUnknownHtml }
            ?: return
        htmlDialogShowing = true
        HtmlManifestDialog(
            context = this,
            htmlFile = html,
            onConfirm = { manifest ->
                thread {
                    try {
                        val target = SharedMiniAppStore.targetForSource(html)
                        val installed = MiniAppInstaller(this).installHtmlWithManifestToDirectory(html, target, manifest)
                        runOnUiThread {
                            htmlDialogShowing = false
                            toast("Установлено: ${installed.name}")
                            reload()
                        }
                    } catch (e: Exception) {
                        runOnUiThread {
                            htmlDialogShowing = false
                            toast(e.message ?: "Ошибка установки HTML")
                        }
                    }
                }
            },
            onCancel = {
                skippedUnknownHtml += html.absolutePath
                htmlDialogShowing = false
            }
        ).show()
    }

    private fun showSettings() {
        val options = arrayOf("Вид списка", "Сортировка", "Тема", "Цвет акцента", "Папка MiniApps")
        AlertDialog.Builder(this)
            .setTitle("Настройки")
            .setItems(options) { _, which ->
                when (which) {
                    0 -> chooseView()
                    1 -> chooseSort()
                    2 -> chooseTheme()
                    3 -> chooseAccent()
                    4 -> showSharedFolderInfo()
                }
            }
            .show()
    }

    private fun ensureSharedFolderAccess() {
        runCatching { SharedMiniAppStore.ensureRoot() }
        if (!SharedMiniAppStore.hasFileAccess()) {
            AlertDialog.Builder(this)
                .setTitle("Доступ к MiniApps")
                .setMessage("Для чтения ZIP и папок из /storage/emulated/0/MiniApps нужен доступ ко всем файлам.")
                .setPositiveButton("Открыть настройки") { _, _ -> startActivity(SharedMiniAppStore.settingsIntent(this)) }
                .setNegativeButton("Позже", null)
                .show()
        }
    }

    private fun showSharedFolderInfo() {
        val root = SharedMiniAppStore.root()
        AlertDialog.Builder(this)
            .setTitle("Папка mini-apps")
            .setMessage("${root.absolutePath}\n\nПоложите сюда ZIP или папку с manifest.json. ZIP распакуется в папку с тем же именем.")
            .setPositiveButton("OK", null)
            .show()
    }

    private fun chooseView() = AlertDialog.Builder(this)
        .setTitle("Вид приложений")
        .setSingleChoiceItems(arrayOf("Список", "Плитки"), if (prefs.grid) 1 else 0) { dialog, which ->
            prefs.grid = which == 1
            dialog.dismiss()
            reload()
        }
        .show()

    private fun chooseSort() = AlertDialog.Builder(this)
        .setTitle("Сортировка")
        .setSingleChoiceItems(
            arrayOf("Название A-Z", "Название Z-A", "Версия A-Z", "Версия Z-A"),
            when {
                prefs.sort == "version" && prefs.sortDesc -> 3
                prefs.sort == "version" -> 2
                prefs.sortDesc -> 1
                else -> 0
            }
        ) { dialog, which ->
            prefs.sort = if (which >= 2) "version" else "name"
            prefs.sortDesc = which == 1 || which == 3
            dialog.dismiss()
            reload()
        }
        .show()

    private fun chooseTheme() = AlertDialog.Builder(this)
        .setTitle("Тема")
        .setSingleChoiceItems(
            arrayOf("Тема устройства", "Светлая", "Тёмная"),
            when (prefs.theme) {
                "light" -> 1
                "dark" -> 2
                else -> 0
            }
        ) { dialog, which ->
            prefs.theme = arrayOf("system", "light", "dark")[which]
            dialog.dismiss()
            recreate()
        }
        .show()

    private fun chooseAccent() {
        val colors = intArrayOf(
            Color.rgb(54, 91, 255),
            Color.rgb(0, 150, 136),
            Color.rgb(233, 80, 110),
            Color.rgb(245, 146, 30)
        )
        AlertDialog.Builder(this)
            .setTitle("Цвет акцента")
            .setSingleChoiceItems(
                arrayOf("Синий", "Бирюзовый", "Розовый", "Оранжевый"),
                colors.indexOfFirst { it == prefs.accent }.coerceAtLeast(0)
            ) { dialog, which ->
                prefs.accent = colors[which]
                dialog.dismiss()
                recreate()
            }
            .show()
    }

    private fun showMenu(app: InstalledMiniApp) {
        AlertDialog.Builder(this)
            .setItems(arrayOf("Информация", "Сбросить разрешения", "Очистить storage", "Удалить")) { _, which ->
                when (which) {
                    0 -> AlertDialog.Builder(this)
                        .setMessage(File(repo.dir(app.manifest.id), "manifest.json").readText())
                        .setPositiveButton("OK", null)
                        .show()
                    1 -> {
                        getSharedPreferences("permissions.${app.manifest.id}", 0).edit().clear().apply()
                        toast("Разрешения сброшены")
                    }
                    2 -> {
                        File(repo.dir(app.manifest.id), "storage.json").delete()
                        getSharedPreferences("mini.${app.manifest.id}", 0).edit().clear().apply()
                        toast("Storage очищен")
                    }
                    3 -> AlertDialog.Builder(this)
                        .setItems(arrayOf("Удалить приложение", "Удалить приложение и данные")) { _, data ->
                            repo.delete(app.manifest.id, data == 1)
                            reload()
                        }
                        .show()
                }
            }
            .show()
    }

    private fun toast(message: String) = Toast.makeText(this, message, Toast.LENGTH_LONG).show()
}

private class MiniAppAdapter(
    private val items: List<InstalledMiniApp>,
    private val grid: Boolean,
    private val accent: Int,
    private val iconFile: (InstalledMiniApp) -> File,
    private val launch: (InstalledMiniApp) -> Unit,
    private val menu: (InstalledMiniApp) -> Unit
) : RecyclerView.Adapter<MiniAppAdapter.H>() {
    class H(view: View) : RecyclerView.ViewHolder(view) {
        val icon: ImageButton = view.findViewWithTag("icon")
        val title: TextView = view.findViewWithTag("title")
        val details: TextView = view.findViewWithTag("details")
        val menu: ImageButton = view.findViewWithTag("menu")
    }

    override fun onCreateViewHolder(parent: ViewGroup, type: Int): H {
        val context = parent.context
        val card = LinearLayout(context).apply {
            orientation = if (grid) LinearLayout.VERTICAL else LinearLayout.HORIZONTAL
            gravity = if (grid) Gravity.CENTER_HORIZONTAL else Gravity.CENTER_VERTICAL
            setPadding(if (grid) context.dp(10) else context.dp(8), context.dp(10), context.dp(8), context.dp(10))
            setBackgroundColor(if (grid) Color.argb(24, accent.red(), accent.green(), accent.blue()) else Color.TRANSPARENT)
            isClickable = true
            isFocusable = true
            layoutParams = RecyclerView.LayoutParams(-1, -2).apply { setMargins(0, 0, 0, context.dp(10)) }
        }

        val icon = ImageButton(context).apply {
            tag = "icon"
            contentDescription = "Запустить приложение"
            setImageResource(android.R.drawable.ic_menu_gallery)
            setColorFilter(Color.WHITE)
            setBackgroundColor(accent)
            scaleType = ImageView.ScaleType.CENTER_INSIDE
        }

        val title = TextView(context).apply {
            tag = "title"
            textSize = if (grid) 15f else 17f
            setTypeface(typeface, Typeface.BOLD)
            maxLines = if (grid) 2 else 1
            ellipsize = TextUtils.TruncateAt.END
        }

        val details = TextView(context).apply {
            tag = "details"
            textSize = if (grid) 12f else 13f
            maxLines = if (grid) 3 else 2
            ellipsize = TextUtils.TruncateAt.END
            setPadding(0, 3, 0, 0)
        }

        val menuButton = ImageButton(context).apply {
            tag = "menu"
            contentDescription = "Детали приложения"
            setImageResource(android.R.drawable.ic_menu_more)
            setBackgroundColor(Color.TRANSPARENT)
        }

        if (grid) {
            val top = FrameLayout(context)
            top.addView(icon, FrameLayout.LayoutParams(context.dp(64), context.dp(64), Gravity.START or Gravity.TOP))
            top.addView(menuButton, FrameLayout.LayoutParams(context.dp(44), context.dp(44), Gravity.END or Gravity.TOP))
            card.addView(top, LinearLayout.LayoutParams(-1, context.dp(68)))
            card.addView(title, LinearLayout.LayoutParams(-1, -2))
            card.addView(details, LinearLayout.LayoutParams(-1, -2))
        } else {
            card.addView(icon, LinearLayout.LayoutParams(context.dp(58), context.dp(58)))
            val text = LinearLayout(context).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(context.dp(12), 0, context.dp(4), 0)
            }
            text.addView(title, LinearLayout.LayoutParams(-1, -2))
            text.addView(details, LinearLayout.LayoutParams(-1, -2))
            card.addView(text, LinearLayout.LayoutParams(0, -2, 1f))
            card.addView(menuButton, LinearLayout.LayoutParams(context.dp(44), context.dp(50)))
        }

        return H(card)
    }

    override fun getItemCount() = items.size

    override fun onBindViewHolder(holder: H, position: Int) {
        val app = items[position]
        holder.title.text = app.manifest.name
        holder.details.text = app.manifest.description ?: "Локальное mini-app приложение"

        holder.icon.clearColorFilter()
        holder.icon.setBackgroundColor(accent)
        holder.icon.setImageResource(android.R.drawable.ic_menu_gallery)
        holder.icon.setColorFilter(Color.WHITE)
        val icon = iconFile(app)
        if (icon.isFile) {
            BitmapFactory.decodeFile(icon.absolutePath)?.let {
                holder.icon.setBackgroundColor(Color.TRANSPARENT)
                holder.icon.clearColorFilter()
                holder.icon.setImageBitmap(it)
            }
        }

        holder.itemView.setOnClickListener { launch(app) }
        holder.icon.setOnClickListener { launch(app) }
        holder.menu.setOnClickListener { menu(app) }
    }
}

private fun Int.red() = Color.red(this)
private fun Int.green() = Color.green(this)
private fun Int.blue() = Color.blue(this)
private fun Context.dp(value: Int) = (value * resources.displayMetrics.density + 0.5f).toInt()
