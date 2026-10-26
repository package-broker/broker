import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint, RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { rowActionsRule } from './eslint-ui-actions.mjs';

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const filename = path.join(repositoryRoot, 'packages/ui/src/pages/example.tsx');
const invalid = (code, ...messageIds) => ({
  code,
  filename,
  errors: messageIds.map((messageId) => ({ messageId })),
});

tester.run('row-actions', rowActionsRule, {
  valid: [
    'function SourceActions() { return <RowActions actions={actions} />; }',
    'const SourceActions = () => <RowActions actions={actions} />;',
    'function SourceActions() { return <Button />; }',
    'function SourceSettings() { return <><Button size="sm" /><Button /></>; }',
    {
      code: 'function SourceActions() { return <><Button size="sm" /><Button /></>; }',
      filename: path.join(repositoryRoot, 'packages/ui/src/pages/sources.tsx'),
      options: [{ allowlist: ['packages/ui/src/pages/sources.tsx'] }],
    },
    '<td><RowActions entityLabel="Package" actions={actions} /></td>',
    '<td><Button>Edit</Button></td>',
    '<td><DropdownMenu><DropdownMenuTrigger>More</DropdownMenuTrigger><DropdownMenuContent><Button>Delete</Button></DropdownMenuContent></DropdownMenu></td>',
    '<td>{editing ? <Button>Save</Button> : <Button>Edit</Button>}</td>',
    '<td>{editing && <Button>Save</Button>}</td>',
    '<td>{<Button>Edit</Button> || <Button>Sync</Button>}</td>',
    '<div>{actions.map(action => <Button size="sm" />)}</div>',
    '<tr><td><Button>Edit</Button></td><td><Button>Sync</Button></td></tr>',
    '<div><Button size="sm">Edit</Button><Button>Sync</Button></div>',
    '<form><Button size="sm">Save</Button><Button>Cancel</Button></form>',
    '<td><form><Button>Save</Button></form><form><Button>Delete</Button></form></td>',
    '<td><RowActions actions={actions} /><Button>Details</Button></td>',
    '<DataTable columns={[{ key: "actions", render: () => <RowActions actions={actions} /> }]} />',
    'const config = { key: "actions", render: () => <Button size="sm" /> };',
    '<Settings columns={[{ key: "actions", render: () => <Button size="sm" /> }]} />',
    '<div className="transaction-actions"><Button size="sm" /><Button /></div>',
    {
      code: '<td><Button size="sm">Edit</Button><Button>Sync</Button></td>',
      filename,
      options: [{ allowlist: ['packages/ui/src/pages/example.tsx'] }],
    },
    'import { RowActions as Actions } from "../components/ui/row-actions.js"; <td><Actions actions={actions} /></td>',
  ],
  invalid: [
    invalid('function SourceActions() { return <><Button /><Button /></>; }', 'composition'),
    invalid('const SourceActions = () => <><Button /><DropdownMenuTrigger /></>;', 'composition'),
    invalid(
      'const SourceActions = function () { return <div><Button size="sm" /><Button /></div>; };',
      'composition',
      'size',
    ),
    invalid('function SourceActions() { return <Button size="sm" />; }', 'size'),
    invalid(
      'function SourceActions() { return <div className="row-actions"><Button /><Button /></div>; }',
      'composition',
    ),
    invalid('<td>{actions.map(action => <Button key={action.id} />)}</td>', 'composition'),
    invalid(
      '<div role="group" aria-label={`Actions for ${name}`}><Button /><Button /></div>',
      'composition',
    ),
    invalid('<td>{(<><Button /><Button /></>) || null}</td>', 'composition'),
    invalid('<td><Button size="sm">Edit</Button><Button>Sync</Button></td>', 'composition', 'size'),
    invalid(
      '<TableRow><TableCell><Button size={size}>Edit</Button></TableCell></TableRow>',
      'size',
    ),
    invalid('<tr><td><div><Button size="default" /></div></td></tr>', 'size'),
    invalid('<td><Button /><DropdownMenuTrigger /></td>', 'composition'),
    invalid(
      '<td><Button /><DropdownMenu><DropdownMenuTrigger /></DropdownMenu></td>',
      'composition',
    ),
    invalid('<td><div><Button /></div><span><Button /></span></td>', 'composition'),
    invalid('<td><>{enabled && <Button />}{other ? <Button /> : null}</></td>', 'composition'),
    invalid('<div className="flex row-actions gap-2"><Button /><Button /></div>', 'composition'),
    invalid('<div data-slot="row-actions"><Button /><Button /></div>', 'composition'),
    invalid(
      '<div role="group" aria-label="Actions for package"><Button /><Button /></div>',
      'composition',
    ),
    invalid('<div className="row-actions"><Button size="sm" /></div>', 'size'),
    invalid(
      'import { Button as Action } from "../components/ui/button.js"; <td><Action /><Action /></td>',
      'composition',
    ),
    invalid(
      'import * as UI from "../components/ui/index.js"; <td><UI.Button size="sm" /><UI.DropdownMenuTrigger /></td>',
      'composition',
      'size',
    ),
    invalid(
      'import { DropdownMenuTrigger as More } from "../components/ui/dropdown-menu.js"; <td><Button /><More /></td>',
      'composition',
    ),
    invalid('<td><Button {...props} /><Button {...other} /></td>', 'composition'),
    invalid('<td><Button className={cn("h-8", styles)} /><Button /></td>', 'composition'),
    invalid(
      '<DataTable columns={[{ key: "actions", render: () => <div><Button /><Button /></div> }]} />',
      'composition',
    ),
    invalid(
      '<DataTable columns={[{ key: "name", render: () => <Button size="sm" /> }]} />',
      'size',
    ),
    invalid(
      '<DataTable columns={[{ key: "actions", render: () => <div><Button size="sm">Edit</Button><Button>Sync</Button></div> }]} />',
      'composition',
      'size',
    ),
    invalid(
      '<DataTable columns={[{ key: "actions", render: () => { return <><Button /><Button /></>; } }]} />',
      'composition',
    ),
    {
      ...invalid('<td><Button /><Button /></td>', 'composition'),
      options: [{ allowlist: ['other/packages/ui/src/pages/example.tsx'] }],
    },
  ],
});

it('enables enforcement only on pages and honors the configured migration paths', async () => {
  const eslint = new ESLint({ cwd: repositoryRoot });
  const code = '<td><Button size="sm">Edit</Button><Button>Sync</Button></td>';
  const diagnostics = async (filePath) => {
    const [result] = await eslint.lintText(code, { filePath });
    return result.messages
      .filter((message) => message.ruleId === 'ui-actions/row-actions')
      .map((message) => message.messageId)
      .sort();
  };
  assert.deepEqual(await diagnostics('packages/ui/src/pages/audit.tsx'), ['composition', 'size']);
  assert.deepEqual(await diagnostics('packages/ui/src/components/ui/example.tsx'), []);
  for (const page of ['packages', 'projects', 'sources', 'tokens']) {
    assert.deepEqual(await diagnostics(`packages/ui/src/pages/${page}.tsx`), []);
  }
});

it('honors repository-relative allowlist paths when ESLint runs from packages/ui', async () => {
  const eslint = new ESLint({ cwd: path.join(repositoryRoot, 'packages/ui') });
  const code = 'function SourceActions() { return <><Button size="sm" /><Button /></>; }';
  for (const page of ['packages', 'projects', 'sources', 'tokens', 'example']) {
    const [result] = await eslint.lintText(code, { filePath: `src/pages/${page}.tsx` });
    const messages = result.messages
      .filter((message) => message.ruleId === 'ui-actions/row-actions')
      .map((message) => message.messageId)
      .sort();
    assert.deepEqual(messages, page === 'example' ? ['composition', 'size'] : []);
  }
});
