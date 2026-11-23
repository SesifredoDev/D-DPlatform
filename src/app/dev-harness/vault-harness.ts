// TEMPORARY visual-test harness for the Obsidian view. Delete before committing.
import { Component } from '@angular/core';
import { ObsidianViewComponent } from '../pages/dashboard/obsidian-view/obsidian-view.component';

@Component({
  selector: 'app-vault-harness',
  standalone: true,
  imports: [ObsidianViewComponent],
  template: `<div style="height:100vh;background:#313338"><app-obsidian-view serverId="harness"></app-obsidian-view></div>`,
})
export class VaultHarness {}
