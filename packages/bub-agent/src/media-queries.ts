// Match complete argv shapes. An unknown option may change a nominally read-only command.
export function isMediaQuery(profile: string, argv: string[]): boolean {
  if (argv.length === 1 && ['help', '--help', '-h', '--version'].includes(argv[0]!)) return true;
  const schema = profile === 'dreamina' && argv[0] === 'schema';
  const words = argv.slice(0, schema ? 1 : 2);
  if ((!schema && words.length !== 2) || words.some((word) => !word || word.includes(' '))) return false;
  const [group] = words;
  const command = words.join(' ');
  const rest = argv.slice(words.length);
  const id = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
  const number = /^\d+$/;
  const options: Record<string, RegExp> = {};
  if (profile === 'dreamina') {
    if (
      ![
        'schema',
        'auth status',
        'auth account',
        'model find',
        'model list',
        'canvas current',
        'canvas ls',
        'voice list',
        'operation status',
      ].includes(command)
    )
      return false;
    options['--format'] = /^(json|table)$/;
    if (command === 'model find') {
      let names = 0;
      while (rest.length && !rest[0]!.startsWith('-')) {
        if (!rest.shift()!.trim()) return false;
        names++;
      }
      if (!names) return false;
    }
    if (command === 'model list' || command === 'model find') options['--type'] = /^(image|video|audio)$/;
    if (command === 'canvas ls') {
      options['--limit'] = number;
      options['--cursor'] = id;
    }
    if (command === 'voice list') {
      options['--count'] = number;
      options['--offset'] = number;
      options['--model'] = id;
    }
    if (command === 'operation status') {
      if (!id.test(rest.shift() || '')) return false;
      options['--project-id'] = id;
    }
  } else if (profile === 'libtv') {
    if (
      !['account list', 'account ls', 'project list', 'project ls', 'node list', 'group list'].includes(
        command,
      )
    )
      return false;
    if (group === 'project') {
      options['-p'] = number;
      options['-s'] = number;
    }
  } else return false;
  for (let i = 0; i < rest.length;) {
    const flag = rest[i++]!;
    if (profile === 'dreamina' && flag === '--non-interactive') continue;
    if (!Object.hasOwn(options, flag) || !options[flag]!.test(rest[i++] || '')) return false;
  }
  return true;
}
