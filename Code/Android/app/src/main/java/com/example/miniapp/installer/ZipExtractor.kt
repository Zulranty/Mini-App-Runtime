package com.example.miniapp.installer

import java.io.*
import java.util.zip.ZipInputStream

object ZipExtractor {
 fun extract(zip:File,target:File) {
  var total=0L; var count=0
  ZipInputStream(BufferedInputStream(FileInputStream(zip))).use { input -> while(true) { val entry=input.nextEntry ?: break; count++; if(count>RuntimeLimits.MAX_FILE_COUNT) throw InstallException("Too many files")
   if(!ManifestValidator.safePath(entry.name)) throw InstallException("Unsafe ZIP path")
   val output=File(target,entry.name); if(!output.canonicalPath.startsWith(target.canonicalPath+File.separator)) throw InstallException("Zip Slip blocked")
   if(entry.isDirectory) output.mkdirs() else { output.parentFile?.mkdirs(); FileOutputStream(output).use { out -> val buf=ByteArray(8192); while(true) { val n=input.read(buf); if(n<0) break; total+=n; if(total>RuntimeLimits.MAX_UNPACKED_SIZE_MB*1024L*1024) throw InstallException("Unpacked archive too large"); out.write(buf,0,n) } } }; input.closeEntry()
  }}
 }
}
