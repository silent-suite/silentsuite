package io.silentsuite.sync.ui.setup

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.widget.Toast
import io.silentsuite.sync.R

class SignupReturnActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Toast.makeText(this, R.string.signup_returned_from_web, Toast.LENGTH_LONG).show()
        val continuationToken = intent.data?.getQueryParameter("continuation")
        if (SignupContinuationRegistry.isValid(continuationToken)) {
            startActivity(Intent(this, LoginActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                .putExtra(LoginActivity.EXTRA_SIGNUP_CONTINUATION_TOKEN, continuationToken))
        } else {
            // A process-death callback cannot safely resume an authenticator flow.
            // Clear any restored task so its obsolete response is finished/canceled.
            startActivity(Intent(this, LoginActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
        }
        finish()
    }
}
