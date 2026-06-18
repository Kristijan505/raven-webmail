<script lang="ts">
  import type { User } from '$lib/types';
  export let data: { user: User };
  let user: User | null = data?.user ?? null;
  let lastData = data;
  // Re-sync only when SvelteKit delivers a fresh `data` object, so the optimistic
  // `user.name = ...` edit in editName() isn't re-derived away (see mailbox/search).
  $: if (data !== lastData) { lastData = data; user = data?.user ?? null; }

	import LockReset from '~icons/mdi/lock-reset';
	import DrawPen from '~icons/mdi/draw';
	import CircularGraph from '$lib/CircularGraph.svelte';
	import MenuItem from '$lib/Menu/MenuItem.svelte';
	import Password from '$lib/Password.svelte';
	import Dialog from '$lib/Dialog.svelte';
  import Ripple from '$lib/Ripple.svelte';
  import { action, plural, _put } from '$lib/util';

  import AccountEdit from "~icons/mdi/account-edit-outline";
  import TextField from "$lib/TextField.svelte";
  import { _message } from "$lib/Notify/notify";
  import { locale } from "$lib/locale";
  import AccountHeader from "$lib/Dashboard/AccountHeader.svelte";
	import TransitionPage from '$lib/TransitionPage.svelte';

	const gb = (size: number) => (size / 1024 ** 3).toFixed(2);

  let passwordDialogOpen = false;
	let currentPassword = '';
	let newPassword = '';
	let confirmPassword = '';

	const updatePassword = action(async () => {
		if (newPassword.length < 6) throw new Error($locale.validation.Password_too_short);
		if (newPassword !== confirmPassword) throw new Error($locale.validation.Passwords_dont_match);
			
    await _put(`/api/me`, {
      existingPassword: currentPassword,
      password: newPassword,
    });
    
    currentPassword = '';
		newPassword = '';
		confirmPassword = '';

    passwordDialogOpen = false;

    _message($locale.notifier.Password_updated);
  })

  let nameOpen = false;
  let newName = "";
  $: if (!nameOpen) {
    newName = user?.name || "";
  }
  const editName = action(async () => {
    if (!user) return;
    if(!newName?.trim()) return;
    await _put("/api/me", { name: newName });
    user.name = newName
    nameOpen = false;
    _message($locale.notifier.Name_updated);
  })
</script>

<style>
	.account {
		flex-direction: column;
    --spacing: 1.5rem;
		background: rgba(0, 0, 0, 0.025);
		overflow-x: hidden;
		overflow-y: auto;
		height: 100%;
	}

	.bottom-space {
		height: 7em;
		flex: none;
	}

	.box {
		margin: 2rem 1rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 4px;
    display: flex;
    flex-direction: column;
	}

	.box-title {
		display: flex;
		flex-direction: row;
		align-items: center;
    font-size: 1.25em;
    flex: none;
    border-bottom: var(--border) 1px solid;
    padding: 1rem;
	}

	.box-title > .comment {
		font-size: 0.8em;
		color: var(--text-muted);
		margin-inline-start: 0.5em;
	}

	.quota-body {
		display: flex;
		flex-direction: row;
		flex: none;
	}

	.quota-body > :global(svg) {
		width: 10em;
		height: 10em;
	}

	.quota-desc {
		flex: none;
		align-self: center;
	}

	.quota-desc > .percent {
		font-size: 1.5em;
		font-weight: 500;
		color: var(--pc);
		margin-bottom: 0.1em;
	}

	.quota-desc > .used {
		font-size: 1.15em;
		color: var(--text);
	}

	.quota-desc > .total {
		font-size: 1.15em;
		color: var(--text-muted);
	}

	.password-dialog > .field {
		margin-bottom: 1.5rem;
	}

	.send {
		margin-top: 1rem;
		display: flex;
		justify-content: flex-end;
	}

  .menu {
    padding: 0.5rem 0;
  }
</style>

<svelte:head>
  <title>{$locale.My_account}</title>
</svelte:head>

<TransitionPage>
  {#if user}
  <div class="account">
    <AccountHeader {user} />
  
    <div class="box elev3 common-actions">
      <div class="box-title">{$locale.Common_actions}</div>
      <div class="menu box-content">
        <MenuItem icon={AccountEdit} on:click={() => nameOpen = true}>
          {$locale.Edit_your_name}
        </MenuItem>
        <MenuItem icon={DrawPen} href="/signature">
          {$locale.Edit_your_signature}
        </MenuItem>
        <MenuItem icon={LockReset} on:click={() => passwordDialogOpen = true}>
          {$locale.Update_your_password}
        </MenuItem>
      </div>
    </div>

    <div class="box elev3 quota storage-quota">
      <div class="box-title">{$locale.Storage}</div>
      <div class="quota-body">
        <CircularGraph
          start={0}
          end={user.limits.quota.used / user.limits.quota.allowed}
        />
        <div class="quota-desc">
          <div class="percent">
            {Math.round((user.limits.quota.used / user.limits.quota.allowed) * 100)}%
          </div>
          <div class="used">
            {gb(user.limits.quota.used)} GB
          </div>
          <div class="total">
            {$locale.of} {gb(user.limits.quota.allowed)} GB
          </div>
        </div>
      </div>
    </div>

    <div class="box elev3 quota imap-download-quota">
      <div class="box-title">
        {$locale.IMAP_Download}
        <span class="comment">{$locale.daily}</span>
      </div>
      <div class="quota-body">
        <CircularGraph
          start={0}
          end={user.limits.imapDownload.used / user.limits.imapDownload.allowed}
        />
        <div class="quota-desc">
          <div class="percent">
            {Math.round(
              (user.limits.imapDownload.used / user.limits.imapDownload.allowed) * 100
            )}%
          </div>
          <div class="used">
            {gb(user.limits.imapDownload.used)} GB
          </div>
          <div class="total">
            {$locale.of} {gb(user.limits.imapDownload.allowed)} GB
          </div>
        </div>
      </div>
    </div>

    <div class="box elev3 quota imap-upload-quota">
      <div class="box-title">
        {$locale.IMAP_Upload}
        <span class="comment">{$locale.daily}</span>
      </div>
      <div class="quota-body">
        <CircularGraph
          start={0}
          end={user.limits.imapUpload.used / user.limits.imapUpload.allowed}
        />
        <div class="quota-desc">
          <div class="percent">
            {Math.round((user.limits.imapUpload.used / user.limits.imapUpload.allowed) * 100)}%
          </div>
          <div class="used">
            {gb(user.limits.imapUpload.used)} GB
          </div>
          <div class="total">
            {$locale.of} {gb(user.limits.imapUpload.allowed)} GB
          </div>
        </div>
      </div>
    </div>

    <div class="box elev3 quota pop3-download-quota">
      <div class="box-title">
        {$locale.POP3_Download}
        <span class="comment">{$locale.daily}</span>
      </div>
      <div class="quota-body">
        <CircularGraph
          start={0}
          end={user.limits.pop3Download.used / user.limits.pop3Download.allowed}
        />
        <div class="quota-desc">
          <div class="percent">
            {Math.round(
              (user.limits.pop3Download.used / user.limits.pop3Download.allowed) * 100
            )}%
          </div>
          <div class="used">
            {gb(user.limits.pop3Download.used)} GB
          </div>
          <div class="total">
            {$locale.of} {gb(user.limits.pop3Download.allowed)} GB
          </div>
        </div>
      </div>
    </div>

    <div class="box elev3 quota received-quota">
      <div class="box-title">
        {$locale.Received}
        <span class="comment">{$locale.by_minute}</span>
      </div>
      <div class="quota-body">
        <CircularGraph start={0} end={user.limits.received.used / user.limits.received.allowed} />
        <div class="quota-desc">
          <div class="percent">
            {Math.round((user.limits.received.used / user.limits.received.allowed) * 100)}%
          </div>
          <div class="used">
            {user.limits.received.used} {user.limits.received.used === 1 ? "message" : "messages"}
          </div>
          <div class="total">
            {$locale.of} {user.limits.received.allowed} {user.limits.received.allowed === 1 ? "message" : "messages"}
          </div>
        </div>
      </div>
    </div>

    <div class="box elev3 quota recipients-quota">
      <div class="box-title">
        {$locale.Sent}
        <span class="comment">{$locale.daily}</span>
      </div>
      <div class="quota-body">
        <CircularGraph
          start={0}
          end={user.limits.recipients.used / user.limits.recipients.allowed}
        />
        <div class="quota-desc">
          <div class="percent">
            {Math.round((user.limits.recipients.used / user.limits.recipients.allowed) * 100)}%
          </div>
          <div class="used">
            {user.limits.recipients.used} {plural(user.limits.recipients.used, $locale.message_count)}
          </div>
          <div class="total">
            {$locale.of} {user.limits.recipients.allowed} {plural(user.limits.recipients.allowed, $locale.message_count)}
          </div>
        </div>
      </div>
    </div>

    <div class="box elev3 quota forwards-quota">
      <div class="box-title">
        {$locale.Forwarded}
        <span class="comment">{$locale.daily}</span>
      </div>
      <div class="quota-body">
        <CircularGraph
          start={0}
          end={user.limits.forwards.used / user.limits.forwards.allowed}
        />
        <div class="quota-desc">
          <div class="percent">
            {Math.round((user.limits.forwards.used / user.limits.forwards.allowed) * 100)}%
          </div>
          <div class="used">
            {user.limits.forwards.used} {plural(user.limits.forwards.used, $locale.message_count)}
          </div>
          <div class="total">
            {$locale.of} {user.limits.forwards.allowed} {plural(user.limits.forwards.allowed, $locale.message_count)}
          </div>
        </div>
      </div>
    </div>

    <div class="bottom-space"></div>
  </div>
  {/if}
  </TransitionPage>

{#if user && passwordDialogOpen}
	<Dialog onClose={() => passwordDialogOpen = false} width="500px" title={$locale.Update_your_password}>
		<form class="password-dialog" on:submit|preventDefault={updatePassword}>
			<div class="field">
				<Password label={$locale.Current_password} bind:value={currentPassword} />
			</div>
			<div class="field">
				<Password label={$locale.New_password} bind:value={newPassword} />
			</div>
			<div class="field">
				<Password label={$locale.Confirm_password} bind:value={confirmPassword} />
			</div>

			<div class="send">
				<button class="btn-light btn-primary elev2">
          {$locale.Save}
          <Ripple />
        </button>
			</div>
		</form>
	</Dialog>
{/if}

{#if user && nameOpen}
  <Dialog title={$locale.Edit_your_name} onClose={() => nameOpen = false} width="500px">
    <form class="password-dialog" on:submit|preventDefault={editName}>
			<div class="field">
				<TextField label={$locale.New_name} bind:value={newName} />
			</div>
			<div class="send">
				<button class="btn-light btn-primary elev2">
          {$locale.Save}
          <Ripple />
        </button>
			</div>
		</form>
  </Dialog>
{/if}
