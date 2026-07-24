package com.example.miniapp

import com.example.miniapp.installer.HtmlManifestReader
import org.junit.Assert.assertEquals
import org.junit.Test

class HtmlManifestReaderTest {
    @Test fun singleFileEntryUsesManifestName() {
        assertEquals("HSV Editor.html", HtmlManifestReader.entryForName("HSV Editor"))
    }

    @Test fun singleFileEntryReplacesInvalidFileNameCharacters() {
        assertEquals("My_App_.html", HtmlManifestReader.entryForName("My/App?"))
    }
}
