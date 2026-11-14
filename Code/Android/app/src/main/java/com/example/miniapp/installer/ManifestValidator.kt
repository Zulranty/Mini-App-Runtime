package com.example.miniapp.installer
import com.example.miniapp.model.MiniAppManifest
import com.example.miniapp.model.MiniAppPermission
import java.io.File
object RuntimeLimits { const val RUNTIME_VERSION="1.5.25"; const val MAX_ARCHIVE_SIZE_MB=20; const val MAX_UNPACKED_SIZE_MB=50; const val MAX_FILE_COUNT=1000; const val SUPPORTED_SDK_VERSION=2; const val MAX_VALUE_BYTES=64*1024; const val MAX_STORAGE_BYTES=5*1024*1024; const val MAX_READ_FILE_BYTES=5*1024*1024; const val MAX_WRITTEN_FILE_BYTES=10*1024*1024 }
class InstallException(val code:String, message:String): Exception(message) { constructor(message:String):this("source_file_invalid",message) }
object ManifestValidator { private val id=Regex("[A-Za-z0-9._-]+")
 fun validate(m:MiniAppManifest,root:File){if(!validId(m.id))throw InstallException("source_file_invalid","Invalid app id");if(m.name.isBlank()||!SemVer.valid(m.version))throw InstallException("source_file_invalid","version must be SemVer");if(m.sdkVersion !in 1..RuntimeLimits.SUPPORTED_SDK_VERSION)throw InstallException("unsupported_sdk_version","Unsupported SDK version");m.minRuntimeVersion?.let{if(!SemVer.valid(it))throw InstallException("source_file_invalid","minRuntimeVersion must be SemVer")};if(!safePath(m.entry)||!File(root,m.entry).canonicalFile.startsWithin(root))throw InstallException("source_file_invalid","Invalid entry path");if(!File(root,m.entry).isFile)throw InstallException("source_file_invalid","Entry file does not exist");if(m.permissions.any{MiniAppPermission.fromWire(it)==null})throw InstallException("source_file_invalid","Unknown permission");m.network?.let { n -> if(!m.permissions.contains("network")||(n.allow.isEmpty()&&n.discoveryServices.isEmpty())||n.allow.any{!validNetworkOrigin(it)}||n.discoveryServices.size>8||n.discoveryServices.any{!com.example.miniapp.services.LocalDeviceService.validService(it)}||(n.discoveryServices.isNotEmpty()&&(!n.allowHttp||!n.allowLocalNetwork)))throw InstallException("source_file_invalid","Invalid network configuration") }}
 private fun validNetworkOrigin(value:String):Boolean { val match=Regex("^(https?)://(\\*\\.)?([A-Za-z0-9.-]+)(?::([0-9]{1,5}))?$").matchEntire(value)?:return false; val port=match.groupValues[4].toIntOrNull(); return port==null||port in 1..65535 }
 fun validId(value:String) = id.matches(value) && value !in setOf(".", "..")
 fun safePath(path:String)=path.isNotBlank()&&!path.startsWith('/')&&!path.contains("\\")&&path.split('/').none{it==".."||it.isEmpty()}
 private fun File.startsWithin(root:File)=path.startsWith(root.canonicalPath+File.separator)
}
object SemVer {
    private val pattern = Regex("""(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?""")

    fun valid(value: String): Boolean {
        val match = pattern.matchEntire(value) ?: return false
        return match.groupValues[4].split('.').none { it.length > 1 && it[0] == '0' && numeric(it) }
    }

    fun compare(left: String, right: String): Int {
        require(valid(left) && valid(right))
        val a = left.substringBefore('+').split('-', limit = 2)
        val b = right.substringBefore('+').split('-', limit = 2)
        val core = compareParts(a[0], b[0])
        if (core != 0) return core
        if (a.size != b.size) return b.size.compareTo(a.size)
        return if (a.size == 1) 0 else compareParts(a[1], b[1])
    }

    private fun numeric(value: String) = value.all { it in '0'..'9' }

    private fun compareParts(left: String, right: String): Int {
        val a = left.split('.')
        val b = right.split('.')
        for (i in 0 until minOf(a.size, b.size)) {
            val aNumeric = numeric(a[i])
            val bNumeric = numeric(b[i])
            if (aNumeric != bNumeric) return if (aNumeric) -1 else 1
            if (aNumeric && a[i].length != b[i].length) return a[i].length.compareTo(b[i].length)
            val order = a[i].compareTo(b[i])
            if (order != 0) return order
        }
        return a.size.compareTo(b.size)
    }
}
