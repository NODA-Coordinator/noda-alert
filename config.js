/* NODA Alert phone app settings.
 *
 * Save a copy of this file named config.js in the same folder, then fill in the three items below.
 * Nothing here is secret: these values are meant to be public and only identify your project.
 * Never put the service account key (the file with "private_key" in it) here or anywhere on the web host.
 */

// 1. Your Apps Script web app URL (Apps Script: Deploy > Manage deployments). It ends in /exec.
var NODA_APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxAmUnAtd_4zX9GtmcDMy7EzXeIew2gldn0AbdTeJbwFtpWoXgZcelr87lJWS_0OC_S/exec';

// 2. Your Firebase web app settings.
//    Firebase console: Project settings (gear icon) > General > Your apps > SDK setup and configuration > Config.
//    Replace the whole block below, from "const firebaseConfig" to the closing "};", with the one Firebase shows you.
const firebaseConfig = {
  apiKey: "PASTE",
  authDomain: "PASTE",
  projectId: "PASTE",
  storageBucket: "PASTE",
  messagingSenderId: "PASTE",
  appId: "PASTE"
};

// 3. Your Web Push certificate key pair (the long public key, about 88 characters).
//    Firebase console: Project settings > Cloud Messaging > Web configuration > Web Push certificates.
var NODA_VAPID_KEY = 'BEJygTIKLdwSKFT7xWaqrrz67BJyQtn-IC1KdxgGG_FKakRqilBJORpxZTMDnKhoJQbIsxttDWiAThl9Pr_xDE8';

// Leave this line as it is.
window.NODA_CONFIG = { appsScriptUrl: NODA_APPS_SCRIPT_URL, firebase: typeof firebaseConfig !== 'undefined' ? firebaseConfig : null, vapidKey: NODA_VAPID_KEY };
