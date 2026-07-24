package com.example.miniapp
import com.example.miniapp.installer.*
import com.example.miniapp.model.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import kotlin.io.path.createTempDirectory
class ManifestValidatorTest {
 @Test fun safePathsRejectTraversal(){assertFalse(ManifestValidator.safePath("../index.html"));assertFalse(ManifestValidator.safePath("a/../b"));assertTrue(ManifestValidator.safePath("assets/a.js"))}
 @Test fun idAndRequiredFieldsAreChecked(){val root=createTempDirectory().toFile();File(root,"index.html").writeText("");val ok=MiniAppManifest("com.demo_1","Demo","1.0.0",1,"index.html",null,null,null,emptySet());ManifestValidator.validate(ok,root);assertThrows(Exception::class.java) { ManifestValidator.validate(ok.copy(id="bad id"),root) };assertThrows(Exception::class.java) { ManifestValidator.validate(ok.copy(version="1"),root) };ManifestValidator.validate(ok.copy(sdkVersion=2),root);assertThrows(Exception::class.java) { ManifestValidator.validate(ok.copy(sdkVersion=3),root) }}
 @Test fun minRuntimeMustBeSemVer(){val root=createTempDirectory().toFile();File(root,"index.html").writeText("");val app=MiniAppManifest("a","a","1.0.0",2,"index.html",null,null,null,emptySet(),"1.4.0");ManifestValidator.validate(app,root);assertThrows(Exception::class.java){ManifestValidator.validate(app.copy(minRuntimeVersion="1.4"),root)}}
 @Test fun semVerUsesPrereleasePrecedence(){assertTrue(SemVer.compare("1.4.0","1.4.0-beta.2")>0);assertTrue(SemVer.compare("1.4.0-beta.2","1.4.0-beta.11")<0);assertTrue(SemVer.compare("1.4.0-beta","1.4.0-beta.1")<0)}
 @Test fun newPermissionsAreRecognized(){val r=createTempDirectory().toFile();File(r,"index.html").writeText("");ManifestValidator.validate(MiniAppManifest("a","a","1.0.0",1,"index.html",null,null,null,setOf("network","notifications","clipboard.read","files.directory","system.open","haptics")),r)}
 @Test fun unknownPermissionIsRejected(){val r=createTempDirectory().toFile();File(r,"index.html").writeText("");assertThrows(Exception::class.java) { ManifestValidator.validate(MiniAppManifest("a","a","1.0.0",1,"index.html",null,null,null,setOf("network.invalid")),r) }}
 @Test fun networkPolicyRequiresPermissionAndValidOrigins(){val r=createTempDirectory().toFile();File(r,"index.html").writeText("");val policy=NetworkConfig(setOf("https://api.example.com","https://*.example.com"));val app=MiniAppManifest("a","a","1.0.0",1,"index.html",null,null,null,setOf("network"),network=policy);ManifestValidator.validate(app,r);assertThrows(Exception::class.java){ManifestValidator.validate(app.copy(permissions=emptySet()),r)};assertThrows(Exception::class.java){ManifestValidator.validate(app.copy(network=NetworkConfig(setOf("https://example.com/path"))),r)};assertThrows(Exception::class.java){ManifestValidator.validate(app.copy(network=NetworkConfig(setOf("https://*"))),r)}}
 @Test fun fileSaveAndSharePermissionsAreAccepted(){val r=createTempDirectory().toFile();File(r,"index.html").writeText("");ManifestValidator.validate(MiniAppManifest("a","a","1.0.0",1,"index.html",null,null,null,setOf("files.save","share")),r)}
 @Test fun htmlManifestJsonCanBeExtracted(){val html="""<script type="application/miniapp+json">{"id":"com.demo.html","name":"HTML","version":"1.0.0","sdkVersion":1,"permissions":["storage"]}</script>""";assertTrue(HtmlManifestReader.extractJson(html).contains("com.demo.html"))}
}
