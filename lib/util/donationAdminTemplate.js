export default function donationAdminTemplate() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Donations Dashboard</title>
  <style>
    :root {
      --bg: #071422;
      --panel: #0f2238;
      --panel2: #132b45;
      --line: rgba(255,255,255,.09);
      --text: #e8f1ff;
      --muted: #9db0c8;
      --accent: #64ffda;
      --danger: #ff8080;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      background: radial-gradient(circle at 10% 0%, #103055 0, transparent 45%), var(--bg);
      color: var(--text);
      padding: 20px;
    }
    .wrap { max-width: 980px; margin: 0 auto; display: grid; gap: 16px; }
    .panel {
      background: rgba(15, 34, 56, .9);
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 16px;
      box-shadow: 0 12px 30px rgba(0,0,0,.18);
    }
    h1, h2 { margin: 0; }
    h1 { font-size: 1.2rem; }
    h2 { font-size: 1rem; margin-bottom: 10px; }
    .muted { color: var(--muted); font-size: .9rem; }
    .grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
    }
    .stat {
      background: var(--panel2);
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 10px;
    }
    .stat .label { color: var(--muted); font-size: .75rem; text-transform: uppercase; letter-spacing: .06em; }
    .stat .value { margin-top: 4px; font-weight: 700; }
    .bar {
      width: 100%; height: 10px; border-radius: 999px; background: rgba(255,255,255,.08); overflow: hidden; margin-top: 10px;
    }
    .bar > div {
      height: 100%; width: 0%; background: linear-gradient(90deg, #64ffda, #00a7b5); transition: width .2s ease;
    }
    .controls, .form-grid {
      display: grid;
      gap: 10px;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      align-items: end;
    }
    label { display: block; font-size: .85rem; color: var(--muted); margin-bottom: 4px; }
    input, select, button {
      width: 100%;
      border-radius: 8px;
      border: 1px solid var(--line);
      background: #0f2339;
      color: var(--text);
      padding: 10px;
      font-size: .95rem;
    }
    button {
      cursor: pointer;
      background: rgba(100,255,218,.14);
      border-color: rgba(100,255,218,.25);
      color: var(--accent);
      font-weight: 700;
    }
    button.primary {
      background: var(--accent);
      border-color: var(--accent);
      color: #052237;
    }
    button.secondary {
      background: rgba(157,176,200,.12);
      border-color: rgba(157,176,200,.28);
      color: #d5e4f5;
    }
    button.row-action {
      width: auto;
      padding: 6px 10px;
      font-size: .82rem;
    }
    button.row-action.danger {
      background: rgba(255,128,128,.12);
      border-color: rgba(255,128,128,.35);
      color: #ffb1b1;
    }
    .status { margin-top: 8px; font-size: .9rem; color: var(--muted); min-height: 1.2em; }
    .status.error { color: var(--danger); }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: .92rem;
    }
    th, td {
      border-top: 1px solid var(--line);
      padding: 10px 8px;
      text-align: left;
      vertical-align: top;
    }
    th { color: var(--muted); font-weight: 600; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .82rem; }
    .pill {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 999px;
      background: rgba(100,255,218,.1);
      border: 1px solid rgba(100,255,218,.15);
      color: #cffff3;
      font-size: .78rem;
    }
    .hidden { display: none; }
    @media (max-width: 900px) {
      .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .controls, .form-grid { grid-template-columns: 1fr 1fr; }
    }
    @media (max-width: 640px) {
      body { padding: 12px; }
      .controls, .form-grid { grid-template-columns: 1fr; }
      table { display: block; overflow-x: auto; white-space: nowrap; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="panel">
      <h1>Donations Dashboard</h1>
      <p class="muted">Manual donation confirmations update the public donation bar and Wall of Thanks immediately.</p>
      <p class="muted">Open this page with your token in the URL: <span class="mono">/donations/admin?token=YOUR_TOKEN</span></p>
    </div>

    <div class="panel">
      <h2>Month Summary</h2>
      <div class="controls">
        <div>
          <label for="monthSelect">Month</label>
          <select id="monthSelect"></select>
        </div>
        <div>
          <label for="tokenInput">Admin Token</label>
          <input id="tokenInput" type="password" autocomplete="off" placeholder="Required">
        </div>
        <div>
          <label>&nbsp;</label>
          <button id="refreshBtn" type="button">Refresh</button>
        </div>
        <div>
          <label>&nbsp;</label>
          <button id="copyLinkBtn" type="button">Copy Token Link</button>
        </div>
      </div>
      <div class="grid" style="margin-top:12px;">
        <div class="stat"><div class="label">Raised</div><div class="value" id="raisedStat">$0</div></div>
        <div class="stat"><div class="label">Goal</div><div class="value" id="goalStat">$50</div></div>
        <div class="stat"><div class="label">Remaining</div><div class="value" id="remainingStat">$50</div></div>
        <div class="stat"><div class="label">Donations</div><div class="value" id="countStat">0</div></div>
      </div>
      <div class="bar"><div id="progressFill"></div></div>
      <div class="status" id="loadStatus"></div>
    </div>

    <div class="panel">
      <h2 id="formTitle">Add Confirmed Donation</h2>
      <form id="addDonationForm">
        <input id="editDonationIdInput" name="donationId" type="hidden">
        <div class="form-grid">
          <div>
            <label for="firstNameInput">First Name</label>
            <input id="firstNameInput" name="firstName" type="text" maxlength="24" placeholder="Alex" required>
          </div>
          <div>
            <label for="amountInput">Amount (USD)</label>
            <input id="amountInput" name="amountUsd" type="number" min="0.01" step="0.01" placeholder="5.00" required>
          </div>
          <div>
            <label for="sourceInput">Source</label>
            <input id="sourceInput" name="source" type="text" maxlength="64" value="manual-paypal-check">
          </div>
          <div>
            <label for="txnInput">PayPal Txn ID (optional)</label>
            <input id="txnInput" name="txnId" type="text" maxlength="128" placeholder="Optional">
          </div>
        </div>
        <div class="form-grid" style="grid-template-columns: 2fr 1fr 1fr 1fr 1fr; margin-top:10px;">
          <div>
            <label for="noteInput">Note (optional)</label>
            <input id="noteInput" name="note" type="text" maxlength="160" placeholder="e.g. confirmed from PayPal on Feb 26">
          </div>
          <div>
            <label for="createdAtInput">Date/Time (optional)</label>
            <input id="createdAtInput" name="createdAt" type="datetime-local">
          </div>
          <div>
            <label>&nbsp;</label>
            <button id="fillNowBtn" type="button">Use Now</button>
          </div>
          <div>
            <label>&nbsp;</label>
            <button id="submitDonationBtn" class="primary" type="submit">Add Donation</button>
          </div>
          <div>
            <label>&nbsp;</label>
            <button id="cancelEditBtn" class="secondary hidden" type="button">Cancel Edit</button>
          </div>
        </div>
      </form>
      <div class="status" id="formStatus"></div>
    </div>

    <div class="panel">
      <h2>Donations</h2>
      <div class="muted" id="tableTitle">No data loaded yet.</div>
      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>Name</th>
            <th>Amount</th>
            <th>Source</th>
            <th>Txn ID</th>
            <th>Note</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody id="donationsTbody">
          <tr><td colspan="7" class="muted">Load a month to see donations.</td></tr>
        </tbody>
      </table>
    </div>

    <div class="panel">
      <h2>Donation Settings</h2>
      <p class="muted">Configure the goal bar and donation goal amount visible to users.</p>
      <div class="form-grid" style="grid-template-columns: 1fr 1fr 1fr 1fr; margin-top:10px; align-items:end;">
        <div>
          <label for="goalAmountInput">Goal Amount (USD)</label>
          <input id="goalAmountInput" type="number" min="1" max="10000" step="1" value="50">
        </div>
        <div style="display:flex;align-items:center;gap:8px;padding:10px 0;">
          <input id="showGoalBarCheck" type="checkbox" style="width:auto;accent-color:var(--accent);">
          <label for="showGoalBarCheck" style="margin:0;cursor:pointer;">Show goal bar</label>
        </div>
        <div style="display:flex;align-items:center;gap:8px;padding:10px 0;">
          <input id="hideGoalBarWhenReachedCheck" type="checkbox" style="width:auto;accent-color:var(--accent);">
          <label for="hideGoalBarWhenReachedCheck" style="margin:0;cursor:pointer;">Hide bar when goal reached</label>
        </div>
        <div>
          <button id="saveSettingsBtn" class="primary" type="button">Save Settings</button>
        </div>
      </div>
      <div class="status" id="settingsStatus"></div>
    </div>

    <div class="panel">
      <h2>A/B Test — Donation Panel Variants</h2>
      <p class="muted">Controls which donation copy/layout visitors see. Weights determine relative frequency (0 = disabled).</p>

      <div id="abWeightsSection" style="margin-top:12px;">
        <div class="muted">Loading A/B data...</div>
      </div>

      <div style="margin-top:12px;">
        <h2 style="font-size:.95rem;">Performance by Month</h2>
        <div id="abStatsSection">
          <div class="muted">Loading...</div>
        </div>
      </div>

      <div class="status" id="abStatus"></div>
    </div>
  </div>

  <script>
    (function () {
      const monthSelect = document.getElementById('monthSelect');
      const tokenInput = document.getElementById('tokenInput');
      const refreshBtn = document.getElementById('refreshBtn');
      const copyLinkBtn = document.getElementById('copyLinkBtn');
      const fillNowBtn = document.getElementById('fillNowBtn');
      const addDonationForm = document.getElementById('addDonationForm');
      const formTitle = document.getElementById('formTitle');
      const loadStatusEl = document.getElementById('loadStatus');
      const formStatus = document.getElementById('formStatus');
      const tableTitle = document.getElementById('tableTitle');
      const donationsTbody = document.getElementById('donationsTbody');
      const progressFill = document.getElementById('progressFill');
      const raisedStat = document.getElementById('raisedStat');
      const goalStat = document.getElementById('goalStat');
      const remainingStat = document.getElementById('remainingStat');
      const countStat = document.getElementById('countStat');
      const createdAtInput = document.getElementById('createdAtInput');
      const firstNameInput = document.getElementById('firstNameInput');
      const amountInput = document.getElementById('amountInput');
      const sourceInput = document.getElementById('sourceInput');
      const txnInput = document.getElementById('txnInput');
      const noteInput = document.getElementById('noteInput');
      const editDonationIdInput = document.getElementById('editDonationIdInput');
      const submitDonationBtn = document.getElementById('submitDonationBtn');
      const cancelEditBtn = document.getElementById('cancelEditBtn');

      let latestStatus = null;
      let editingDonationId = null;
      let donationsById = new Map();

      function fmtUsd(n) {
        return '$' + Number(n || 0).toFixed(2).replace(/\\.00$/, '');
      }

      function getToken() {
        return (tokenInput.value || '').trim();
      }

      function getSelectedMonth() {
        return (monthSelect.value || '').trim();
      }

      function setStatus(el, text, isError) {
        el.textContent = text || '';
        el.classList.toggle('error', !!isError);
      }

      function qsWithToken(extra) {
        const params = new URLSearchParams(extra || {});
        const token = getToken();
        if (token) params.set('token', token);
        return params;
      }

      function formatDate(value) {
        if (!value) return '';
        try {
          return new Date(value).toLocaleString();
        } catch (e) {
          return String(value);
        }
      }

      function toLocalDatetimeValue(value) {
        if (!value) return '';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return '';
        const pad = (n) => String(n).padStart(2, '0');
        return date.getFullYear() + '-' +
          pad(date.getMonth() + 1) + '-' +
          pad(date.getDate()) + 'T' +
          pad(date.getHours()) + ':' +
          pad(date.getMinutes());
      }

      function clearEditMode() {
        editingDonationId = null;
        editDonationIdInput.value = '';
        formTitle.textContent = 'Add Confirmed Donation';
        submitDonationBtn.textContent = 'Add Donation';
        cancelEditBtn.classList.add('hidden');
      }

      function resetFormToDefaults() {
        addDonationForm.reset();
        sourceInput.value = 'manual-paypal-check';
        clearEditMode();
      }

      function beginEditDonation(donationId) {
        if (!donationId || !donationsById.has(donationId)) return;
        const donation = donationsById.get(donationId);
        editingDonationId = donationId;
        editDonationIdInput.value = donationId;
        formTitle.textContent = 'Edit Donation';
        submitDonationBtn.textContent = 'Save Changes';
        cancelEditBtn.classList.remove('hidden');

        firstNameInput.value = donation.firstName || 'Anonymous';
        amountInput.value = String(Number(donation.amountUsd || 0).toFixed(2));
        sourceInput.value = donation.source || 'manual-paypal-check';
        txnInput.value = donation.txnId || '';
        noteInput.value = donation.note || '';
        createdAtInput.value = toLocalDatetimeValue(donation.createdAt);
      }

      function renderMonthOptions(status) {
        const selected = (status && status.selectedMonthKey) || '';
        monthSelect.innerHTML = '';
        const seen = new Set();
        (status.months || []).forEach((month) => {
          if (!month || !month.monthKey || seen.has(month.monthKey)) return;
          seen.add(month.monthKey);
          const opt = document.createElement('option');
          opt.value = month.monthKey;
          opt.textContent = month.monthLabel + ' (' + fmtUsd(month.totalUsd) + ', ' + month.donationsCount + ')';
          if (month.monthKey === selected) opt.selected = true;
          monthSelect.appendChild(opt);
        });
        if (!monthSelect.value && selected) {
          const opt = document.createElement('option');
          opt.value = selected;
          opt.textContent = selected;
          opt.selected = true;
          monthSelect.appendChild(opt);
        }
      }

      function renderSettings(settings) {
        if (!settings) return;
        var goalInput = document.getElementById('goalAmountInput');
        var showCheck = document.getElementById('showGoalBarCheck');
        var hideCheck = document.getElementById('hideGoalBarWhenReachedCheck');
        if (goalInput) goalInput.value = String(settings.goalAmountUsd || 50);
        if (showCheck) showCheck.checked = !!settings.showGoalBar;
        if (hideCheck) hideCheck.checked = !!settings.hideGoalBarWhenReached;
      }

      function renderSummary(status) {
        latestStatus = status;
        raisedStat.textContent = fmtUsd(status.raisedUsd);
        goalStat.textContent = fmtUsd(status.goalUsd);
        remainingStat.textContent = fmtUsd(status.remainingUsd);
        countStat.textContent = String(status.donationsCount || 0);
        progressFill.style.width = Math.max(0, Math.min(100, Number(status.progressPercent || 0))) + '%';
        tableTitle.textContent = (status.monthLabel || status.selectedMonthKey) + ' · ' + (status.donations || []).length + ' donation(s)';
        renderMonthOptions(status);
        if (status.settings) renderSettings(status.settings);

        const rows = Array.isArray(status.donations) ? status.donations : [];
        donationsById = new Map();
        donationsTbody.innerHTML = '';
        if (!rows.length) {
          const tr = document.createElement('tr');
          tr.innerHTML = '<td colspan="7" class="muted">No donations recorded for this month yet.</td>';
          donationsTbody.appendChild(tr);
          return;
        }

        rows.forEach((row) => {
          if (row.id) {
            donationsById.set(String(row.id), row);
          }
          const tr = document.createElement('tr');
          const txn = row.txnId ? '<span class="mono">' + escapeHtmlText(row.txnId) + '</span>' : '';
          const note = row.note ? escapeHtmlText(row.note) : '';
          const action = row.id
            ? '<button type="button" class="row-action" data-edit-donation-id="' + escapeHtmlText(row.id) + '">Edit</button> ' +
              '<button type="button" class="row-action danger" data-delete-donation-id="' + escapeHtmlText(row.id) + '">Delete</button>'
            : '<span class="muted">N/A</span>';
          tr.innerHTML =
            '<td>' + escapeHtmlText(formatDate(row.createdAt)) + '</td>' +
            '<td>' + escapeHtmlText(row.firstName || 'Anonymous') + '</td>' +
            '<td>' + fmtUsd(row.amountUsd) + '</td>' +
            '<td><span class="pill">' + escapeHtmlText(row.source || 'manual') + '</span></td>' +
            '<td>' + txn + '</td>' +
            '<td>' + note + '</td>' +
            '<td>' + action + '</td>';
          donationsTbody.appendChild(tr);
        });
      }

      function escapeHtmlText(text) {
        return String(text == null ? '' : text)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      async function refresh(monthKey) {
        try {
          setStatus(loadStatusEl, 'Loading...', false);
          const params = qsWithToken(monthKey ? { month: monthKey } : (getSelectedMonth() ? { month: getSelectedMonth() } : {}));
          const res = await fetch('/donations/admin/status.json?' + params.toString(), { cache: 'no-store' });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            throw new Error(data.err || ('HTTP ' + res.status));
          }
          renderSummary(data);
          setStatus(loadStatusEl, 'Loaded ' + (data.monthLabel || data.selectedMonthKey), false);
        } catch (err) {
          setStatus(loadStatusEl, err.message || 'Failed to load', true);
        }
      }

      function getFormPayload() {
        const fd = new FormData(addDonationForm);
        const payload = Object.fromEntries(fd.entries());
        payload.monthKey = getSelectedMonth();

        if (payload.createdAt) {
          const date = new Date(payload.createdAt);
          if (!Number.isNaN(date.getTime())) {
            payload.createdAt = date.toISOString();
          }
        } else {
          delete payload.createdAt;
        }

        return payload;
      }

      async function submitDonation(ev) {
        ev.preventDefault();
        setStatus(formStatus, 'Saving...', false);

        try {
          const isEditing = !!editingDonationId;
          const payload = getFormPayload();
          const endpoint = isEditing ? '/donations/admin/edit' : '/donations/admin/add';
          const params = qsWithToken();
          const res = await fetch(endpoint + '?' + params.toString(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || !data.ok) {
            throw new Error(data.err || data.reason || ('HTTP ' + res.status));
          }
          setStatus(formStatus, isEditing ? 'Donation updated.' : 'Donation added.', false);
          resetFormToDefaults();
          await refresh(payload.monthKey || getSelectedMonth());
        } catch (err) {
          setStatus(formStatus, err.message || 'Save failed', true);
        }
      }

      async function deleteDonation(donationId) {
        if (!donationId) return;
        const donation = donationsById.get(String(donationId));
        const donationLabel = donation
          ? ((donation.firstName || 'Anonymous') + ' · ' + fmtUsd(donation.amountUsd))
          : 'this donation';

        if (!window.confirm('Delete ' + donationLabel + '? This cannot be undone.')) {
          return;
        }

        setStatus(formStatus, 'Deleting...', false);

        try {
          const params = qsWithToken();
          const res = await fetch('/donations/admin/delete?' + params.toString(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              donationId: donationId,
              monthKey: getSelectedMonth()
            })
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || !data.ok) {
            throw new Error(data.err || data.reason || ('HTTP ' + res.status));
          }

          if (editingDonationId === String(donationId)) {
            resetFormToDefaults();
          }

          setStatus(formStatus, 'Donation deleted.', false);
          await refresh(getSelectedMonth());
        } catch (err) {
          setStatus(formStatus, err.message || 'Delete failed', true);
        }
      }

      var saveSettingsBtn = document.getElementById('saveSettingsBtn');
      var settingsStatusEl = document.getElementById('settingsStatus');
      if (saveSettingsBtn) {
        saveSettingsBtn.addEventListener('click', async () => {
          try {
            setStatus(settingsStatusEl, 'Saving...', false);
            var payload = {
              goalAmountUsd: Number(document.getElementById('goalAmountInput').value) || 50,
              showGoalBar: !!document.getElementById('showGoalBarCheck').checked,
              hideGoalBarWhenReached: !!document.getElementById('hideGoalBarWhenReachedCheck').checked
            };
            var params = qsWithToken();
            var res = await fetch('/donations/admin/settings?' + params.toString(), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload)
            });
            var data = await res.json().catch(() => ({}));
            if (!res.ok || !data.ok) throw new Error(data.err || 'HTTP ' + res.status);
            setStatus(settingsStatusEl, 'Settings saved.', false);
            await refresh(getSelectedMonth());
          } catch (err) {
            setStatus(settingsStatusEl, err.message || 'Save failed', true);
          }
        });
      }

      refreshBtn.addEventListener('click', () => refresh(getSelectedMonth()));
      monthSelect.addEventListener('change', () => {
        clearEditMode();
        setStatus(formStatus, '', false);
        refresh(getSelectedMonth());
      });
      addDonationForm.addEventListener('submit', submitDonation);
      cancelEditBtn.addEventListener('click', () => {
        resetFormToDefaults();
        setStatus(formStatus, 'Edit cancelled.', false);
      });
      fillNowBtn.addEventListener('click', () => {
        const d = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        createdAtInput.value = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
      });
      donationsTbody.addEventListener('click', (ev) => {
        const editBtn = ev.target && ev.target.closest ? ev.target.closest('[data-edit-donation-id]') : null;
        if (editBtn) {
          beginEditDonation(editBtn.getAttribute('data-edit-donation-id'));
          setStatus(formStatus, 'Editing selected donation.', false);
          return;
        }

        const deleteBtn = ev.target && ev.target.closest ? ev.target.closest('[data-delete-donation-id]') : null;
        if (deleteBtn) {
          deleteDonation(deleteBtn.getAttribute('data-delete-donation-id'));
        }
      });
      copyLinkBtn.addEventListener('click', async () => {
        const token = getToken();
        if (!token) {
          setStatus(loadStatusEl, 'Enter token first.', true);
          return;
        }
        const url = new URL(window.location.href);
        url.searchParams.set('token', token);
        try {
          await navigator.clipboard.writeText(url.toString());
          setStatus(loadStatusEl, 'Token link copied.', false);
        } catch (e) {
          setStatus(loadStatusEl, 'Copy failed. URL is in the address bar.', true);
        }
      });

      try {
        const url = new URL(window.location.href);
        const token = url.searchParams.get('token');
        if (token) tokenInput.value = token;
      } catch (e) {}

      resetFormToDefaults();
      refresh();
    })();

    (function setupAbTest() {
      const abWeightsSection = document.getElementById('abWeightsSection');
      const abStatsSection = document.getElementById('abStatsSection');
      const abStatus = document.getElementById('abStatus');

      function getToken() {
        return (document.getElementById('tokenInput').value || '').trim();
      }

      function setAbStatus(text, isError) {
        abStatus.textContent = text || '';
        abStatus.classList.toggle('error', !!isError);
      }

      function renderWeights(stats) {
        var variants = stats.variants || [];
        var weights = stats.weights || {};
        var totalWeight = 0;
        variants.forEach(function(v) { totalWeight += (weights[v.id] || 0); });

        var html = '<div style="display:grid;grid-template-columns:repeat(' + Math.min(variants.length, 4) + ',minmax(0,1fr));gap:10px;align-items:end;">';
        variants.forEach(function(v) {
          var w = weights[v.id] || 0;
          var pct = totalWeight > 0 ? Math.round((w / totalWeight) * 100) : 0;
          html += '<div class="stat">' +
            '<div class="label">' + escHtml(v.id) + ': ' + escHtml(v.label) + '</div>' +
            '<div style="margin-top:6px;">' +
            '<label style="font-size:.8rem;">Weight: <strong id="abWeightVal_' + v.id + '">' + w + '</strong> (' + pct + '%)</label>' +
            '<input type="range" id="abWeight_' + v.id + '" min="0" max="10" step="1" value="' + w + '" ' +
            'style="width:100%;margin-top:4px;accent-color:var(--accent);">' +
            '</div></div>';
        });
        html += '<div style="align-self:end;"><button id="abSaveWeightsBtn" class="primary" type="button">Save Weights</button></div>';
        html += '</div>';
        abWeightsSection.innerHTML = html;

        variants.forEach(function(v) {
          var slider = document.getElementById('abWeight_' + v.id);
          var label = document.getElementById('abWeightVal_' + v.id);
          if (slider && label) {
            slider.addEventListener('input', function() { label.textContent = slider.value; });
          }
        });

        var saveBtn = document.getElementById('abSaveWeightsBtn');
        if (saveBtn) {
          saveBtn.addEventListener('click', function() { saveWeights(variants); });
        }
      }

      function renderStats(stats) {
        var months = stats.months || [];
        var variants = stats.variants || [];
        if (!months.length) {
          abStatsSection.innerHTML = '<div class="muted">No data yet.</div>';
          return;
        }

        var html = '';
        months.forEach(function(month) {
          html += '<div style="margin-bottom:14px;">';
          html += '<h2 style="font-size:.9rem;margin-bottom:6px;">' + escHtml(month.monthKey) + '</h2>';
          html += '<table><thead><tr><th>Variant</th><th>Impressions</th><th>Clicks</th><th>CTR</th></tr></thead><tbody>';

          var bestCtr = -1;
          var bestId = null;
          variants.forEach(function(v) {
            var s = month.variants[v.id] || {};
            if ((s.ctr || 0) > bestCtr && (s.impressions || 0) >= 10) {
              bestCtr = s.ctr;
              bestId = v.id;
            }
          });

          variants.forEach(function(v) {
            var s = month.variants[v.id] || {};
            var isBest = v.id === bestId;
            var style = isBest ? ' style="color:var(--accent);font-weight:700;"' : '';
            html += '<tr' + style + '>' +
              '<td>' + escHtml(v.id) + ' — ' + escHtml(v.label) + (isBest ? ' ★' : '') + '</td>' +
              '<td>' + (s.impressions || 0) + '</td>' +
              '<td>' + (s.clicks || 0) + '</td>' +
              '<td>' + (s.ctr || 0).toFixed(2) + '%</td>' +
              '</tr>';
          });
          html += '</tbody></table></div>';
        });
        abStatsSection.innerHTML = html;
      }

      function escHtml(text) {
        return String(text == null ? '' : text)
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
      }

      async function loadAbStats() {
        try {
          var token = getToken();
          var res = await fetch('/ab/stats?token=' + encodeURIComponent(token), { cache: 'no-store' });
          if (!res.ok) throw new Error('HTTP ' + res.status);
          var stats = await res.json();
          renderWeights(stats);
          renderStats(stats);
          setAbStatus('', false);
        } catch (err) {
          setAbStatus('Failed to load A/B data: ' + err.message, true);
        }
      }

      async function saveWeights(variants) {
        try {
          setAbStatus('Saving weights...', false);
          var weights = {};
          variants.forEach(function(v) {
            var slider = document.getElementById('abWeight_' + v.id);
            weights[v.id] = slider ? Number(slider.value) : 1;
          });
          var token = getToken();
          var res = await fetch('/ab/weights?token=' + encodeURIComponent(token), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ weights: weights })
          });
          var data = await res.json().catch(function() { return {}; });
          if (!res.ok || !data.ok) throw new Error(data.err || 'HTTP ' + res.status);
          if (data.stats) {
            renderWeights(data.stats);
            renderStats(data.stats);
          }
          setAbStatus('Weights saved.', false);
        } catch (err) {
          setAbStatus('Failed to save: ' + err.message, true);
        }
      }

      setTimeout(loadAbStats, 500);
      setInterval(loadAbStats, 30000);
    })();
  </script>
</body>
</html>`
}
