package io.silentsuite.sync.notes.edit

import io.silentsuite.sync.notes.edit.NoteMetaCodec.Merge
import io.silentsuite.sync.notes.edit.NoteMetaCodec.Peek
import org.msgpack.core.buffer.MessageBuffer

/**
 * Evaluation only, not for merge (the msgpack-core evaluation). The one caller in main code of
 * [NoteMetaMsgpack], the form of the note metadata merge that is written on msgpack-core.
 *
 * Nothing in the app calls this object: no screen, no sync run, no receiver, no setting. The app
 * reads and writes note metadata through [NoteMetaCodec] only. Tests are its only callers, and a
 * unit test (NoteMetaLibraryEvaluationTest) fails if any other file of main code and the debug
 * source set names this object, the form or the library. In a release build nothing runs it. It and
 * the form are in the dex because proguard-rules.txt keeps the app's package, and the library code
 * is there because they reach it. The modifier includedescriptorclasses of that rule also keeps, as
 * classes, the five library classes named in the signatures of the form's compiled members.
 *
 * It adds nothing to the form: three calls passed through to one instance, and one question to the
 * library, which buffer class it chose in this process. It sets no system property and no setting
 * of the library.
 */
internal object NoteMetaLibraryEvaluation {
    // One instance, as the unit comparison holds one for each form. Its scratch array is written and
    // never read, so a second thread could not change a result. Use from several threads is not tested.
    private val form = NoteMetaMsgpack()

    fun merge(raw: ByteArray?, name: String, mtime: Long): Merge = form.merge(raw, name, mtime)

    fun fresh(name: String, mtime: Long): Merge.Merged = form.fresh(name, mtime)

    fun peek(raw: ByteArray?): Peek? = form.peek(raw)

    /**
     * The name of the buffer class msgpack-core chose in this process. The call is the one the
     * unpacker's own array input makes for every input, so it reaches nothing the form does not.
     */
    fun bufferClassName(): String = MessageBuffer.wrap(ByteArray(1), 0, 1).javaClass.name
}
