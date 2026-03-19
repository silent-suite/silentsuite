package at.bitfire.cert4android;

import at.bitfire.cert4android.IOnCertificateDecision;

interface ICustomCertService {

    void checkTrusted(in byte[] cert, boolean interactive, boolean foreground, IOnCertificateDecision callback);
    void abortCheck(IOnCertificateDecision callback);

}
