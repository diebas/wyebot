# wyebot Extension

Custom Pi extension for the wyebot development agent.

## Installation

After cloning the wyebot repo, install the extension dependencies:

```bash
cd .pi/extensions/wyebot
npm install
```

This installs the `yaml` package required for parsing `project.yml`.

## Development

The extension is automatically loaded by Pi when it starts. After making changes to `index.ts`, restart the Pi agent to reload the extension.

## Dependencies

- `yaml` — YAML parser for reading project configuration
