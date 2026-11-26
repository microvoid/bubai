const { withDangerousMod } = require('expo/config-plugins');
const fs = require('node:fs');
const path = require('node:path');

const MARKER = '# [bubai] Xcode 26 fmt consteval compatibility fix';

const RUBY_SNIPPET = `
    ${MARKER}
    fmt_base = File.join(installer.sandbox.root.to_s, 'fmt', 'include', 'fmt', 'base.h')
    if File.exist?(fmt_base)
      content = File.read(fmt_base)
      patched = content.gsub(
        /^#\\s*elif defined\\(__apple_build_version__\\) && __apple_build_version__ < 14000029L$/,
        '#elif defined(__apple_build_version__)'
      )
      if patched != content
        File.chmod(0644, fmt_base) rescue nil
        File.write(fmt_base, patched)
      end
    end
`;

module.exports = function withXcode26FmtFix(config) {
  return withDangerousMod(config, [
    'ios',
    (cfg) => {
      const podfilePath = path.join(cfg.modRequest.platformProjectRoot, 'Podfile');
      if (fs.existsSync(podfilePath)) {
        const podfile = fs.readFileSync(podfilePath, 'utf8');
        if (!podfile.includes(MARKER)) {
          const updated = podfile.replace(
            /post_install do \|installer\|/,
            `post_install do |installer|${RUBY_SNIPPET}`,
          );
          fs.writeFileSync(podfilePath, updated, 'utf8');
        }
      }
      return cfg;
    },
  ]);
};
