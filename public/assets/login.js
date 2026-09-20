'use strict';
const form = document.getElementById('login-form');
const msg = document.getElementById('msg');
const submit = document.getElementById('submit');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  msg.classList.add('hidden');
  submit.disabled = true;
  submit.textContent = 'Pruefe...';
  try {
    const res = await fetch('/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user: document.getElementById('user').value,
        password: document.getElementById('password').value,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      location.href = '/';
      return;
    }
    msg.textContent = data.message || 'Login fehlgeschlagen.';
    msg.classList.remove('hidden');
  } catch (err) {
    msg.textContent = 'Server nicht erreichbar.';
    msg.classList.remove('hidden');
  }
  submit.disabled = false;
  submit.textContent = 'Anmelden';
});
