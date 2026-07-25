<style>
  .anchor {
    position: absolute;
    left: 0;
    bottom: 0;
  }
</style>

<script lang="ts">
  export let mailbox: Mailbox;
  export let onMove: (mailbox: Mailbox) => void = () => {}
  export let open = false;

  import type { Mailbox } from "./types";
  import type { DashContext } from "./Dashboard/Dashboard.svelte";

  const { mailboxes } = getContext("dash") as DashContext;

  $: inbox = $mailboxes.find(isInbox)!;
  $: trash = $mailboxes.find(isTrash)!;
  $: junk = $mailboxes.find(isJunk)!;
  $: sent = $mailboxes.find(isSent)!;
  $: others = $mailboxes.filter(item => {
    return item !== inbox && item.specialUse == null;
  })!;

  let folders: Mailbox[] = [];
  // These come from find(): a folder the account happens not to have — a Trash that was
  // deleted, a Junk that was never provisioned — is undefined, and the `!` above only
  // silences the type checker. Reading `.id` off it throws, and this is a reactive
  // block, so the throw lands inside the Svelte flush and freezes the scheduler: the
  // whole view goes inert, not just this menu. Guard each comparison and drop the
  // missing entries from the result instead.
  $: {
    if(inbox && mailbox.id === inbox.id) {
      folders = [
        ...others,
        junk,
        trash,
      ];
    } else if (trash && mailbox.id === trash.id) {
      folders = [
        inbox,
        ...others,
        junk
      ]
    } else if(junk && mailbox.id === junk.id) {
      folders = [
        inbox,
        ...others,
        trash
      ]
    } else if(sent && mailbox.id === sent.id) {
      folders = [
        trash
      ]
    } else if (others.some(item => item.id === mailbox.id)) {
      folders = [
        inbox,
        ...others.filter(item => item.id !== mailbox.id),
        junk,
        trash,
      ]
    }
    // Every branch above can name a folder this account does not have.
    folders = folders.filter(Boolean);
  }


  import MoveTo from "~icons/mdi/folder-move-outline";
  import PortalPopup from "./PortalPopup.svelte";
  import { isJunk, isTrash, isInbox, mailboxIcon, mailboxName, isSent } from "./util";
  import { getContext } from "svelte";
  import Ripple from "./Ripple.svelte";
  import { tooltip, clickable } from "./actions";
  import Menu from "./Menu/Menu.svelte";
  import MenuItem from "./Menu/MenuItem.svelte";
import { locale } from "./locale";
</script>

{#if folders.length}
  <div class="action-group">
    <div class="action btn-dark" use:clickable class:hover={open} on:click={() => open = !open} use:tooltip={$locale.Move_to}>
      <MoveTo/>
      <div class="anchor">
        <PortalPopup anchor="top-left" bind:open>
          <Menu>
            {#each folders as mailbox}
              <MenuItem icon={mailboxIcon(mailbox)} on:click={() => onMove(mailbox)}>
                {mailboxName(mailbox, $locale)}
              </MenuItem>
            {/each}
          </Menu>
        </PortalPopup>
      </div>
      <Ripple />
    </div>
  </div>
{/if}