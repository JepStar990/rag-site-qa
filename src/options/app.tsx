import { KeySection } from './key-section';
import { SettingsForms } from './settings-forms';
import './options.css';

export function App() {
  return (
    <div class="options">
      <header>
        <h1>SiteQA Settings</h1>
        <p class="muted">
          Your DeepSeek key stays in this browser's local extension storage.
          Only prompts and the retrieved site excerpts are sent to DeepSeek.
        </p>
      </header>

      <section>
        <h2>DeepSeek API key</h2>
        <KeySection />
      </section>

      <section>
        <h2>Model, budget, and limits</h2>
        <SettingsForms />
      </section>
    </div>
  );
}
