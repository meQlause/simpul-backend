import { posix } from 'node:path';
import compiler from 'typescript';

type Binding = { module: string; name: string };
type ImportContext = {
  path: string;
  module: string;
  target: string;
  feature?: string;
  targetFeature?: string;
  provider?: string;
  targetProvider?: string;
};

const understanding = ['triage', 'comprehension'];
const databasePackage = /^(?:drizzle-orm|pg|pg-boss)(?:\/|$)/u;

function importsPolicy(context: ImportContext) {
  return (
    understanding.includes(context.feature ?? '') &&
    (['rules', 'people'].includes(context.targetFeature ?? '') ||
      (context.targetFeature === 'vocabulary' && context.target.includes('template')))
  );
}

const importRules = {
  'I-2': (context: ImportContext) =>
    context.path.endsWith('.rules.ts') &&
    (databasePackage.test(context.module) || context.target.startsWith('src/platform/')),
  'I-3': (context: ImportContext) =>
    Boolean(context.feature && context.targetFeature) &&
    context.feature !== context.targetFeature &&
    !context.target.endsWith('/index.js'),
  'I-5': (context: ImportContext) =>
    context.path.startsWith('src/platform/') && context.target.startsWith('src/features/'),
  'I-6': (context: ImportContext) =>
    importsPolicy(context) ||
    (Boolean(context.feature) &&
      context.target.startsWith('src/platform/llm/') &&
      !understanding.includes(context.feature ?? '')),
  'I-7': (context: ImportContext) =>
    !context.path.endsWith('.repository.ts') &&
    !context.path.startsWith('src/platform/db/') &&
    (/^drizzle-orm(?:\/|$)/u.test(context.module) ||
      context.target.startsWith('src/platform/db/schema/')),
  'I-9': (context: ImportContext) =>
    Boolean(context.feature) &&
    context.target.startsWith('src/platform/providers/') &&
    context.target !== 'src/platform/providers/index.js',
  'I-10': (context: ImportContext) =>
    Boolean(context.provider) &&
    (Boolean(context.targetFeature) ||
      (Boolean(context.targetProvider) && context.provider !== context.targetProvider)),
};

function bindingEntries(clause: compiler.ImportClause, module: string): [string, Binding][] {
  const entries: [string, Binding][] = [];

  if (clause.name) {
    entries.push([clause.name.text, { module, name: '*' }]);
  }

  const named = clause.namedBindings;

  if (!named) {
    return entries;
  }

  if (compiler.isNamespaceImport(named)) {
    return [...entries, [named.name.text, { module, name: '*' }]];
  }

  return [
    ...entries,
    ...named.elements.map((element): [string, Binding] => [
      element.name.text,
      { module, name: element.propertyName?.text ?? element.name.text },
    ]),
  ];
}

function collectBindings(syntax: compiler.SourceFile) {
  return new Map(
    syntax.statements.filter(compiler.isImportDeclaration).flatMap((statement) => {
      if (!statement.importClause || !compiler.isStringLiteral(statement.moduleSpecifier)) {
        return [];
      }

      return bindingEntries(statement.importClause, statement.moduleSpecifier.text);
    }),
  );
}

function exportsRepository(syntax: compiler.SourceFile, bindings: Map<string, Binding>) {
  return syntax.statements.filter(compiler.isExportDeclaration).some((statement) => {
    if (statement.moduleSpecifier && compiler.isStringLiteral(statement.moduleSpecifier)) {
      return statement.moduleSpecifier.text.includes('.repository.');
    }

    if (statement.exportClause && compiler.isNamedExports(statement.exportClause)) {
      return statement.exportClause.elements.some((element) =>
        bindings
          .get(element.propertyName?.text ?? element.name.text)
          ?.module.includes('.repository.'),
      );
    }

    return false;
  });
}

function constructorBinding(expression: compiler.Expression, bindings: Map<string, Binding>) {
  if (compiler.isIdentifier(expression)) {
    return bindings.get(expression.text);
  }

  if (
    compiler.isPropertyAccessExpression(expression) &&
    compiler.isIdentifier(expression.expression)
  ) {
    return {
      module: bindings.get(expression.expression.text)?.module,
      name: expression.name.text,
    };
  }

  return undefined;
}

function createsPgConnection(node: compiler.Node, bindings: Map<string, Binding>): boolean {
  if (compiler.isNewExpression(node)) {
    const binding = constructorBinding(node.expression, bindings);

    if (binding?.module === 'pg' && ['Pool', 'Client'].includes(binding.name)) {
      return true;
    }
  }

  return compiler.forEachChild(node, (child) => createsPgConnection(child, bindings)) ?? false;
}

function contextFor(path: string, module: string): ImportContext {
  const target = module.startsWith('.')
    ? posix.normalize(posix.join(posix.dirname(path), module))
    : module;

  return {
    path,
    module,
    target,
    feature: path.match(/^src\/features\/([^/]+)\//u)?.[1],
    targetFeature: target.match(/^src\/features\/([^/]+)\//u)?.[1],
    provider: path.match(/^src\/platform\/providers\/([^/]+)\//u)?.[1],
    targetProvider: target.match(/^src\/platform\/providers\/([^/]+)\//u)?.[1],
  };
}

export function inspectImports(file: string, source: string): string[] {
  const path = file.replaceAll('\\', '/');
  const syntax = compiler.createSourceFile(path, source, compiler.ScriptTarget.Latest, true);
  const bindings = collectBindings(syntax);
  const violations = compiler
    .preProcessFile(source, true, true)
    .importedFiles.flatMap((imported) => {
      const context = contextFor(path, imported.fileName);

      return Object.entries(importRules)
        .filter(([_rule, violates]) => violates(context))
        .map(([rule]) => rule);
    });

  if (path.endsWith('/index.ts') && exportsRepository(syntax, bindings)) {
    violations.push('I-4');
  }

  if (!path.startsWith('src/platform/providers/telegram/') && source.includes('api.telegram.org')) {
    violations.push('I-8');
  }

  if (!path.startsWith('src/platform/db/') && createsPgConnection(syntax, bindings)) {
    violations.push('I-11');
  }

  return [...new Set(violations)];
}
