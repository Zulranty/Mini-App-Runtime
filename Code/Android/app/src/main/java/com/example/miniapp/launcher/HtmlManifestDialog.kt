package com.example.miniapp.launcher

import android.app.AlertDialog
import android.content.Context
import android.graphics.Color
import android.text.InputType
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import com.example.miniapp.installer.RuntimeLimits
import com.example.miniapp.model.MiniAppManifest
import com.example.miniapp.model.MiniAppPermission
import java.io.File

class HtmlManifestDialog(
    private val context: Context,
    private val htmlFile: File,
    private val onConfirm: (MiniAppManifest) -> Unit,
    private val onCancel: () -> Unit
) {
    fun show() {
        val form = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(context.dp(20), context.dp(6), context.dp(20), 0)
        }
        form.addView(TextView(context).apply {
            text = "Найден HTML-файл без manifest: ${htmlFile.name}\nВведите данные mini-app, чтобы установить его."
            textSize = 14f
            setPadding(0, 0, 0, context.dp(12))
        })

        val id = field("App ID", defaultId(htmlFile))
        val name = field("Name", htmlFile.nameWithoutExtension.replace('-', ' ').replace('_', ' ').replaceFirstChar { it.uppercase() })
        val version = field("Version", "1.0.0")
        val description = field("Description", "")
        val author = field("Author", "")
        val permissions = field("Permissions, comma separated", "")
        val error = TextView(context).apply {
            setTextColor(Color.rgb(210, 50, 50))
            visibility = TextView.GONE
            setPadding(0, context.dp(8), 0, 0)
        }
        listOf(id, name, version, description, author, permissions).forEach { form.addView(it) }
        form.addView(error)

        val dialog = AlertDialog.Builder(context)
            .setTitle("Непонятный HTML")
            .setView(ScrollView(context).apply { addView(form) })
            .setPositiveButton("Установить", null)
            .setNegativeButton("Пропустить") { _, _ -> onCancel() }
            .create()

        dialog.setOnShowListener {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                val manifest = MiniAppManifest(
                    id = id.text.toString().trim(),
                    name = name.text.toString().trim(),
                    version = version.text.toString().trim(),
                    sdkVersion = RuntimeLimits.SUPPORTED_SDK_VERSION,
                    entry = "index.html",
                    description = description.text.toString().trim().ifBlank { null },
                    author = author.text.toString().trim().ifBlank { null },
                    icon = null,
                    permissions = permissions.text.toString().split(',')
                        .map { it.trim() }
                        .filter { it.isNotBlank() }
                        .toSet()
                )
                val validationError = validate(manifest)
                if (validationError != null) {
                    error.text = validationError
                    error.visibility = TextView.VISIBLE
                    return@setOnClickListener
                }
                onConfirm(manifest)
                dialog.dismiss()
            }
        }
        dialog.setOnCancelListener { onCancel() }
        dialog.show()
    }

    private fun field(hint: String, value: String): EditText =
        EditText(context).apply {
            this.hint = hint
            setText(value)
            setSingleLine(false)
            maxLines = 2
            inputType = InputType.TYPE_CLASS_TEXT
            setPadding(0, context.dp(4), 0, context.dp(8))
        }

    private fun defaultId(file: File): String =
        "local.${file.nameWithoutExtension.lowercase().replace(Regex("[^a-z0-9._-]"), "_")}".trimEnd('.')

    private fun validate(manifest: MiniAppManifest): String? {
        if (!Regex("[A-Za-z0-9._-]+").matches(manifest.id)) return "App ID может содержать только латинские буквы, цифры, точки, дефисы и подчёркивания."
        if (manifest.name.isBlank()) return "Name не должен быть пустым."
        if (manifest.version.isBlank()) return "Version не должен быть пустым."
        val unknown = manifest.permissions.firstOrNull { MiniAppPermission.fromWire(it) == null }
        if (unknown != null) return "Неизвестный permission: $unknown"
        return null
    }
}

private fun Context.dp(value: Int) = (value * resources.displayMetrics.density + 0.5f).toInt()
