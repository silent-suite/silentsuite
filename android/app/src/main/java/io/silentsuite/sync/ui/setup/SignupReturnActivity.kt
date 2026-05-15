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
        startActivity(Intent(this, LoginActivity::class.java))
        finish()
    }
}
