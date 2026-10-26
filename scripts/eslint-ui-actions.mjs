import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const primitives = new Set(['Button', 'DropdownMenuTrigger', 'RowActions']);
const nameOf = (node) => (node?.type === 'JSXIdentifier' ? node.name : undefined);
const propertyName = (node) => node?.name ?? node?.value;

function attribute(node, name) {
  return node.openingElement.attributes.find(
    (item) => item.type === 'JSXAttribute' && item.name.name === name,
  );
}

function textAttribute(node, name) {
  const value = attribute(node, name)?.value;
  if (value?.type === 'Literal') return value.value;
  if (value?.type === 'JSXExpressionContainer' && value.expression.type === 'Literal')
    return value.expression.value;
  if (value?.type === 'JSXExpressionContainer' && value.expression.type === 'TemplateLiteral')
    return value.expression.quasis[0].value.cooked;
  return undefined;
}

function rowContainer(node) {
  return (
    /(?:^|\s)row-actions(?:\s|$)/.test(textAttribute(node, 'className') ?? '') ||
    textAttribute(node, 'data-slot') === 'row-actions' ||
    (textAttribute(node, 'role') === 'group' &&
      /^actions(?:\s|$)/i.test(textAttribute(node, 'aria-label') ?? ''))
  );
}

function columnRender(node) {
  if (node.type !== 'Property' || propertyName(node.key) !== 'render') return undefined;
  const column = node.parent;
  if (column?.type !== 'ObjectExpression') return undefined;
  let parent = column.parent;
  while (parent && parent.type !== 'JSXAttribute') parent = parent.parent;
  if (parent?.name.name !== 'columns' || nameOf(parent.parent.name) !== 'DataTable')
    return undefined;
  return column.properties.find(
    (item) => item.type === 'Property' && propertyName(item.key) === 'key',
  )?.value;
}

export const rowActionsRule = {
  meta: {
    type: 'problem',
    schema: [
      {
        type: 'object',
        properties: { allowlist: { type: 'array', items: { type: 'string' }, uniqueItems: true } },
        additionalProperties: false,
      },
    ],
    messages: {
      composition: 'Use RowActions for sibling row action buttons so the group owns their size.',
      size: 'Row button size belongs to RowActions; remove the explicit size prop.',
    },
  },
  create(context) {
    const filename = path.relative(repositoryRoot, context.filename).split(path.sep).join('/');
    if (context.options[0]?.allowlist?.includes(filename)) return {};
    const aliases = new Map();
    const namespaces = new Set();
    function component(node) {
      const name = node.openingElement.name;
      if (name.type === 'JSXMemberExpression' && namespaces.has(nameOf(name.object)))
        return nameOf(name.property);
      const local = nameOf(name);
      return aliases.get(local) ?? local;
    }
    function boundary(node) {
      return ['RowActions', 'DropdownMenuContent', 'form', 'dialog', 'Dialog'].includes(
        component(node),
      );
    }
    function controls(node) {
      if (!node) return 0;
      switch (node.type) {
        case 'JSXElement':
          if (boundary(node)) return 0;
          if (['Button', 'DropdownMenuTrigger'].includes(component(node))) return 1;
          return node.children.reduce((sum, child) => sum + controls(child), 0);
        case 'JSXFragment':
          return node.children.reduce((sum, child) => sum + controls(child), 0);
        case 'JSXExpressionContainer':
          return controls(node.expression);
        case 'ConditionalExpression':
          return Math.max(controls(node.consequent), controls(node.alternate));
        case 'LogicalExpression':
          return node.operator === '&&'
            ? controls(node.right)
            : Math.max(controls(node.left), controls(node.right));
        case 'ArrowFunctionExpression':
        case 'FunctionExpression':
          return controls(node.body);
        case 'BlockStatement':
          return Math.max(0, ...node.body.map(controls));
        case 'ReturnStatement':
          return controls(node.argument);
        case 'CallExpression': {
          const count = Math.max(0, ...node.arguments.map(controls));
          if (
            node.callee.type === 'MemberExpression' &&
            propertyName(node.callee.property) === 'map'
          )
            return count > 0 ? Math.max(2, count) : 0;
          return count;
        }
        default:
          return 0;
      }
    }
    function actionsComponent(node) {
      if (
        !['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(
          node.type,
        )
      )
        return false;
      const name =
        node.id?.name ??
        (node.parent?.type === 'VariableDeclarator' ? node.parent.id.name : undefined);
      return /^[A-Z]/.test(name ?? '') && name.endsWith('Actions');
    }
    function contextKind(node) {
      if (actionsComponent(node)) return 'actions';
      if (node.type === 'JSXElement') {
        const name = component(node);
        if (['td', 'TableCell'].includes(name) || rowContainer(node)) return 'actions';
        if (['tr', 'TableRow'].includes(name)) return 'row';
      }
      const column = columnRender(node);
      if (column) return column.value === 'actions' ? 'actions' : 'row';
      return undefined;
    }
    return {
      ImportDeclaration(node) {
        for (const specifier of node.specifiers) {
          if (specifier.type === 'ImportNamespaceSpecifier') namespaces.add(specifier.local.name);
          if (
            specifier.type === 'ImportSpecifier' &&
            primitives.has(propertyName(specifier.imported))
          )
            aliases.set(specifier.local.name, propertyName(specifier.imported));
        }
      },
      JSXElement(node) {
        if (component(node) === 'Button' && attribute(node, 'size')) {
          for (let parent = node.parent; parent; parent = parent.parent) {
            if (contextKind(parent)) {
              context.report({ node: attribute(node, 'size'), messageId: 'size' });
              break;
            }
          }
        }
      },
      'JSXElement:exit'(node) {
        if (contextKind(node) !== 'actions' || controls(node) < 2) return;
        for (let parent = node.parent; parent; parent = parent.parent) {
          if (parent.type === 'JSXElement' && boundary(parent)) break;
          if (contextKind(parent) === 'actions') return;
        }
        context.report({ node: node.openingElement, messageId: 'composition' });
      },
      'Property:exit'(node) {
        const column = columnRender(node);
        if (column?.value === 'actions' && controls(node.value) > 1)
          context.report({ node: node.key, messageId: 'composition' });
      },
      ':matches(FunctionDeclaration, FunctionExpression, ArrowFunctionExpression):exit'(node) {
        if (actionsComponent(node) && controls(node.body) > 1)
          context.report({ node: node.id ?? node, messageId: 'composition' });
      },
    };
  },
};

export default { rules: { 'row-actions': rowActionsRule } };
