// Minimal hand-rolled WebAuthn client - just the base64url <-> ArrayBuffer glue the
// native navigator.credentials API needs. No bundler in this project, so this avoids
// pulling in @simplewebauthn/browser purely to save ~40 lines of encoding code.

function b64urlToBuffer(b64url) {
  const padded = b64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64url.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function bufferToB64url(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function registerTouchId(deviceLabel) {
  const optionsRes = await fetch('/api/auth/webauthn/registration-options');
  if (!optionsRes.ok) throw new Error((await optionsRes.json()).error || 'Could not start registration');
  const options = await optionsRes.json();

  options.challenge = b64urlToBuffer(options.challenge);
  options.user.id = b64urlToBuffer(options.user.id);
  if (options.excludeCredentials) {
    options.excludeCredentials = options.excludeCredentials.map((c) => ({ ...c, id: b64urlToBuffer(c.id) }));
  }

  const credential = await navigator.credentials.create({ publicKey: options });

  const payload = {
    id: credential.id,
    rawId: bufferToB64url(credential.rawId),
    type: credential.type,
    deviceLabel: deviceLabel || navigator.userAgentData?.platform || navigator.platform || 'Device',
    response: {
      clientDataJSON: bufferToB64url(credential.response.clientDataJSON),
      attestationObject: bufferToB64url(credential.response.attestationObject),
      transports: credential.response.getTransports ? credential.response.getTransports() : undefined,
    },
    clientExtensionResults: credential.getClientExtensionResults(),
  };

  const verifyRes = await fetch('/api/auth/webauthn/registration-verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!verifyRes.ok) throw new Error((await verifyRes.json()).error || 'Registration failed');
  return verifyRes.json();
}

async function signInWithTouchId() {
  const optionsRes = await fetch('/api/auth/webauthn/authentication-options');
  if (!optionsRes.ok) throw new Error((await optionsRes.json()).error || 'No Touch ID device registered yet');
  const options = await optionsRes.json();

  options.challenge = b64urlToBuffer(options.challenge);
  if (options.allowCredentials) {
    options.allowCredentials = options.allowCredentials.map((c) => ({ ...c, id: b64urlToBuffer(c.id) }));
  }

  const assertion = await navigator.credentials.get({ publicKey: options });

  const payload = {
    id: assertion.id,
    rawId: bufferToB64url(assertion.rawId),
    type: assertion.type,
    response: {
      clientDataJSON: bufferToB64url(assertion.response.clientDataJSON),
      authenticatorData: bufferToB64url(assertion.response.authenticatorData),
      signature: bufferToB64url(assertion.response.signature),
      userHandle: assertion.response.userHandle ? bufferToB64url(assertion.response.userHandle) : undefined,
    },
    clientExtensionResults: assertion.getClientExtensionResults(),
  };

  const verifyRes = await fetch('/api/auth/webauthn/authentication-verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!verifyRes.ok) throw new Error((await verifyRes.json()).error || 'Sign-in failed');
  return verifyRes.json();
}

function webauthnSupported() {
  return !!(window.PublicKeyCredential && navigator.credentials);
}
