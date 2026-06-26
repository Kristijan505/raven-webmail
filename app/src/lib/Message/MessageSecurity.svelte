<script lang="ts">
  import type { FullMessage, Mailbox } from "$lib/types";
  export let message: FullMessage;
  export let mailbox: Mailbox;

  import { clickable } from "$lib/actions";
  import { locale } from "$lib/locale";

  import ShieldCheck from "~icons/mdi/shield-check-outline";
  import ShieldAlert from "~icons/mdi/shield-alert-outline";
  import ShieldOff from "~icons/mdi/shield-off-outline";
  import Check from "~icons/mdi/check-circle-outline";
  import Close from "~icons/mdi/close-circle-outline";
  import Lock from "~icons/mdi/lock-outline";

  let open = false;

  const domainOf = (addr?: string): string => {
    if(!addr) return "";
    const at = addr.lastIndexOf("@");
    return at === -1 ? "" : addr.slice(at + 1).trim().toLowerCase();
  };

  // Two domains "align" (DMARC-style) when equal or one is a subdomain of the
  // other. WildDuck doesn't surface a DMARC verdict, so this is a heuristic — but
  // require BOTH to look like registrable domains (>=2 labels) before treating one
  // as a suffix of the other, otherwise a bare public suffix like "com" would
  // "align" every .com sender and the badge would over-report a verified sender.
  const aligns = (a?: string | null, b?: string | null): boolean => {
    if(!a || !b) return false;
    if(a === b) return true;
    const labels = (d: string) => d.split(".").filter(Boolean).length;
    if(labels(a) < 2 || labels(b) < 2) return false;
    return a.endsWith("." + b) || b.endsWith("." + a);
  };

  $: fromDomain = domainOf(message.from?.address);
  $: envDomain = domainOf(message.envelope?.from);
  $: vr = message.verificationResults;
  // spf/dkim hold a DOMAIN STRING when the check passed, else null/false/undefined.
  $: spfDomain = typeof vr?.spf === "string" ? vr.spf.toLowerCase() : null;
  $: dkimDomain = typeof vr?.dkim === "string" ? vr.dkim.toLowerCase() : null;
  $: dkimAligned = aligns(dkimDomain, fromDomain);
  $: spfAligned = !!spfDomain && (aligns(spfDomain, fromDomain) || aligns(envDomain, fromDomain));
  $: dmarcPass = dkimAligned || spfAligned;
  $: level = dmarcPass ? "pass" : ((spfDomain || dkimDomain) ? "warn" : "fail");
  $: tlsVersion = vr?.tls?.version;

  $: statusLabel =
    level === "pass" ? $locale.security.Verified_sender :
    level === "warn" ? $locale.security.Partially_verified :
    $locale.security.Not_verified;
</script>

<style>
  .security {
    margin-top: var(--space-2);
    font-size: 0.85rem;
  }

  .summary {
    display: inline-flex;
    flex-direction: row;
    align-items: center;
    gap: 0.35rem;
    cursor: pointer;
    user-select: none;
    border-radius: 0.4rem;
    padding: 0.15rem 0.4rem;
    margin-inline-start: -0.4rem;
  }

  .summary:hover {
    background: var(--surface-2);
  }

  .summary.pass { color: var(--color-success); }
  .summary.warn { color: var(--color-warning); }
  .summary.fail { color: var(--red); }

  .panel {
    margin-top: var(--space-2);
    border: 1px solid var(--border);
    background: var(--surface-2);
    border-radius: var(--radius-md);
    padding: var(--space-3) var(--space-4);
    color: var(--text);
    max-width: 32rem;
  }

  .row {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 0.4rem;
    padding: 0.15rem 0;
  }

  .label {
    color: var(--text-muted);
    min-width: 6.5rem;
  }

  .value {
    word-break: break-all;
  }

  .icon-pass { color: var(--color-success); display: inline-flex; }
  .icon-warn { color: var(--color-warning); display: inline-flex; }
  .icon-fail { color: var(--red); display: inline-flex; }

  .original {
    margin-top: 0.6rem;
  }

  .original a {
    color: var(--text-muted);
  }

  .sep {
    height: 1px;
    background: var(--border);
    margin: var(--space-2) 0;
  }
</style>

<div class="security">
  <div class="summary {level}" use:clickable on:click={() => open = !open}>
    {#if level === "pass"}
      <ShieldCheck />
    {:else if level === "warn"}
      <ShieldAlert />
    {:else}
      <ShieldOff />
    {/if}
    <span>{statusLabel}</span>
  </div>

  {#if open}
    <div class="panel">
      <div class="row">
        <span class="label">{$locale.security.Sender}:</span>
        <span class="value">{message.from?.address || "—"}</span>
      </div>
      <div class="row">
        <span class="label">{$locale.security.Mailed_by}:</span>
        <span class="value">{envDomain || "—"}</span>
      </div>
      <div class="row">
        <span class="label">{$locale.security.Signed_by}:</span>
        <span class="value">{dkimDomain || "—"}</span>
      </div>

      <div class="sep"></div>

      <div class="row">
        {#if spfDomain}
          <span class="icon-pass"><Check /></span>
        {:else}
          <span class={level === "fail" ? "icon-fail" : "icon-warn"}><Close /></span>
        {/if}
        <span class="label">{$locale.security.SPF}</span>
        <span class="value">{spfDomain || "—"}</span>
      </div>
      <div class="row">
        {#if dkimDomain}
          <span class="icon-pass"><Check /></span>
        {:else}
          <span class={level === "fail" ? "icon-fail" : "icon-warn"}><Close /></span>
        {/if}
        <span class="label">{$locale.security.DKIM}</span>
        <span class="value">{dkimDomain || "—"}</span>
      </div>
      <div class="row">
        {#if dmarcPass}
          <span class="icon-pass"><Check /></span>
        {:else}
          <span class={level === "fail" ? "icon-fail" : "icon-warn"}><Close /></span>
        {/if}
        <span class="label">{$locale.security.DMARC}</span>
        <span class="value">{dmarcPass ? $locale.security.Aligned : $locale.security.Not_aligned}</span>
      </div>

      <div class="sep"></div>

      <div class="row">
        {#if tlsVersion}
          <span class="icon-pass"><Lock /></span>
          <span class="label">{$locale.security.Encrypted}</span>
          <span class="value">{tlsVersion}</span>
        {:else}
          <span class={level === "fail" ? "icon-fail" : "icon-warn"}><Close /></span>
          <span class="label">{$locale.security.Not_encrypted}</span>
        {/if}
      </div>

      <div class="original">
        <a href={"/api/mailboxes/" + mailbox.id + "/messages/" + message.id + "/source"} target="_blank" rel="noopener noreferrer">
          {$locale.security.View_original}
        </a>
      </div>
    </div>
  {/if}
</div>
