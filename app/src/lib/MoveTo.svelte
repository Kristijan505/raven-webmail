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


  // Destination rules live in moveTargets.ts so they can be unit-tested on their own —
  // this is product semantics (what may be filed where), not view code, and it is the
  // kind of rule a later refactor silently loosens. See that file for the reasoning and
  // for the TODO about recording a message's origin.
  $: folders = moveDestinations(mailbox, $mailboxes);


  import MoveTo from "~icons/mdi/folder-move-outline";
  import PortalPopup from "./PortalPopup.svelte";
  import { mailboxIcon, mailboxName } from "./util";
  import { moveDestinations } from "./moveTargets";
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