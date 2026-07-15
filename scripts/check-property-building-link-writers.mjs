import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_REPO_ROOT = resolve(dirname(SCRIPT_PATH), '..');
const DEFAULT_POLICY_PATH = 'scripts/property-building-writer-policy.json';
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx']);
const WRITE_OPERATIONS = new Set(['delete', 'insert', 'update', 'upsert']);
const READ_OPERATIONS = new Set(['select']);
const PROPERTY_LINK_FIELDS = new Set(['building_unit_id', 'buildingUnitId']);
const PROPERTY_DONG_HO_FIELDS = new Set(['dong', 'ho']);
const BUILDING_TABLES = new Set([
    'building_external_refs',
    'building_land_lots',
    'building_units',
    'buildings',
]);
const SAFE_PAYLOAD_INSPECTIONS = new Set([
    'Object.entries',
    'Object.hasOwn',
    'Object.keys',
    'Object.values',
]);
const FORBIDDEN_TABLE_SCOPES = new Map([
    ['src/services/member.queue.service.ts', BUILDING_TABLES],
    ['src/services/supabase.service.ts', new Set(['property_units'])],
]);
const FORBIDDEN_IDENTIFIER_SCOPES = new Map([
    ['src/services/member.queue.service.ts', new Set([
        'findOrCreateBuildingUnit',
        'processSyncPropertiesJob',
    ])],
    ['src/services/gis.queue.service.ts', new Set([
        'linkPropertyUnitsForIndividualHousing',
        'linkPropertyUnitsToBuildingUnits',
    ])],
]);

function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}

function normalizeContext(value) {
    return value.replace(/\s+/g, ' ').trim();
}

function bytewiseCompare(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}

function unwrapExpression(node) {
    let current = node;
    while (
        ts.isAsExpression(current)
        || ts.isNonNullExpression(current)
        || ts.isParenthesizedExpression(current)
        || ts.isSatisfiesExpression?.(current)
        || ts.isTypeAssertionExpression(current)
    ) {
        current = current.expression;
    }
    return current;
}

function staticString(node) {
    if (!node) return null;
    const current = unwrapExpression(node);
    if (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current)) {
        return current.text;
    }
    return null;
}

function staticPropertyName(node) {
    if (ts.isPropertyAccessExpression(node)) return node.name.text;
    if (ts.isElementAccessExpression(node)) return staticString(node.argumentExpression);
    return null;
}

function callPath(call) {
    const expression = unwrapExpression(call.expression);
    if (ts.isIdentifier(expression)) return expression.text;
    if (ts.isPropertyAccessExpression(expression)) {
        const receiver = unwrapExpression(expression.expression);
        if (ts.isIdentifier(receiver)) return `${receiver.text}.${expression.name.text}`;
    }
    if (ts.isElementAccessExpression(expression)) {
        const receiver = unwrapExpression(expression.expression);
        const property = staticString(expression.argumentExpression);
        if (ts.isIdentifier(receiver) && property) return `${receiver.text}.${property}`;
    }
    return null;
}

function lineAt(sourceFile, node) {
    return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function contextFor(sourceFile, node) {
    return normalizeContext(node.getText(sourceFile));
}

function createOccurrence({ kind, path, line, operation, context, sourceFileSha256, name }) {
    const contextSha256 = sha256(context);
    const id = sha256([kind, path, operation ?? '', name ?? '', contextSha256].join('\0')).slice(0, 20);
    return {
        id,
        path,
        line,
        ...(operation ? { operation } : {}),
        ...(name ? { name } : {}),
        contextSha256,
        sourceFileSha256,
    };
}

function chainCallsAfter(call) {
    const calls = [];
    let current = call;

    while (current.parent) {
        let parent = current.parent;
        while (
            ts.isAsExpression(parent)
            || ts.isNonNullExpression(parent)
            || ts.isParenthesizedExpression(parent)
            || ts.isSatisfiesExpression?.(parent)
        ) {
            current = parent;
            parent = current.parent;
            if (!parent) return calls;
        }

        if (
            (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent))
            && parent.expression === current
            && ts.isCallExpression(parent.parent)
            && parent.parent.expression === parent
        ) {
            calls.push({
                call: parent.parent,
                method: staticPropertyName(parent),
            });
            current = parent.parent;
            continue;
        }
        break;
    }

    return calls;
}

function isMethodCall(call, method) {
    const expression = unwrapExpression(call.expression);
    return (
        (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression))
        && staticPropertyName(expression) === method
    );
}

function findDescendantFromCall(node) {
    let found = null;
    const visit = (child) => {
        if (found) return;
        if (ts.isCallExpression(child) && isMethodCall(child, 'from')) {
            found = child;
            return;
        }
        ts.forEachChild(child, visit);
    };
    visit(node);
    return found;
}

function enclosingFunction(node) {
    let current = node.parent;
    while (current) {
        if (ts.isFunctionLike(current)) return current;
        current = current.parent;
    }
    return node.getSourceFile();
}

function collectVariableDeclarations(sourceFile) {
    const declarations = [];
    const visit = (node) => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
            declarations.push({
                name: node.name.text,
                node,
                position: node.getStart(sourceFile),
                scope: enclosingFunction(node),
            });
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return declarations;
}

function resolveVariableDeclaration(identifier, declarations) {
    const position = identifier.getStart(identifier.getSourceFile());
    const scope = enclosingFunction(identifier);
    let resolved = null;
    for (const declaration of declarations) {
        if (
            declaration.name === identifier.text
            && declaration.scope === scope
            && declaration.position < position
            && (!resolved || declaration.position > resolved.position)
        ) {
            resolved = declaration;
        }
    }
    return resolved?.node ?? null;
}

function builderOriginForIdentifier(identifier, declarations, seen = new Set()) {
    const declaration = resolveVariableDeclaration(identifier, declarations);
    if (!declaration || seen.has(declaration)) return null;
    seen.add(declaration);
    const initializer = declaration.initializer && unwrapExpression(declaration.initializer);
    if (!initializer) return null;

    if (ts.isIdentifier(initializer)) {
        return builderOriginForIdentifier(initializer, declarations, seen);
    }

    const fromCall = findDescendantFromCall(initializer);
    if (!fromCall) return null;
    return {
        fromCall,
        table: staticString(fromCall.arguments[0]),
    };
}

function leftmostReceiverIdentifier(expression) {
    let current = unwrapExpression(expression);
    while (true) {
        if (ts.isIdentifier(current)) return current;
        if (ts.isCallExpression(current)) {
            current = unwrapExpression(current.expression);
            continue;
        }
        if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
            current = unwrapExpression(current.expression);
            continue;
        }
        return null;
    }
}

function propertyNameFromAssignmentTarget(node) {
    const target = unwrapExpression(node);
    if (ts.isPropertyAccessExpression(target)) return target.name.text;
    if (ts.isElementAccessExpression(target)) return staticString(target.argumentExpression);
    return null;
}

function receiverIdentifier(node) {
    const current = unwrapExpression(node);
    if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
        const receiver = unwrapExpression(current.expression);
        if (ts.isIdentifier(receiver)) return receiver;
    }
    return null;
}

function objectPropertyName(property) {
    if (ts.isShorthandPropertyAssignment(property)) return property.name.text;
    if (!('name' in property) || !property.name) return null;
    if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) || ts.isNumericLiteral(property.name)) {
        return property.name.text;
    }
    if (ts.isComputedPropertyName(property.name)) return staticString(property.name.expression);
    return null;
}

function bindingPropertyName(binding) {
    if (!binding.propertyName) {
        return ts.isIdentifier(binding.name) ? binding.name.text : null;
    }
    if (ts.isIdentifier(binding.propertyName) || ts.isStringLiteral(binding.propertyName)) {
        return binding.propertyName.text;
    }
    if (ts.isComputedPropertyName(binding.propertyName)) {
        return staticString(binding.propertyName.expression);
    }
    return null;
}

function assignmentBindingPropertyName(property) {
    if (ts.isShorthandPropertyAssignment(property)) return property.name.text;
    if (ts.isPropertyAssignment(property)) return objectPropertyName(property);
    return null;
}

function analyzeObjectPayload(node, fields, unresolvedReasons, label) {
    const current = unwrapExpression(node);
    if (ts.isArrayLiteralExpression(current)) {
        for (const element of current.elements) {
            if (ts.isSpreadElement(element)) {
                unresolvedReasons.add(`${label}:array-spread`);
            } else {
                analyzeObjectPayload(element, fields, unresolvedReasons, label);
            }
        }
        return;
    }
    if (!ts.isObjectLiteralExpression(current)) {
        unresolvedReasons.add(`${label}:non-object-expression`);
        return;
    }

    for (const property of current.properties) {
        if (ts.isSpreadAssignment(property)) {
            unresolvedReasons.add(`${label}:object-spread`);
            continue;
        }
        const name = objectPropertyName(property);
        if (!name) {
            unresolvedReasons.add(`${label}:dynamic-object-key`);
            continue;
        }
        fields.add(name);
    }
}

function aliasNamesForPayload(sourceFile, payloadIdentifier, declarations, mutationCall) {
    const scope = enclosingFunction(mutationCall);
    const aliases = new Set([payloadIdentifier.text]);
    let changed = true;
    while (changed) {
        changed = false;
        const visit = (node) => {
            if (enclosingFunction(node) !== scope) {
                if (ts.isFunctionLike(node) && node !== scope) return;
            }
            if (
                ts.isVariableDeclaration(node)
                && ts.isIdentifier(node.name)
                && node.initializer
                && ts.isIdentifier(unwrapExpression(node.initializer))
                && aliases.has(unwrapExpression(node.initializer).text)
                && !aliases.has(node.name.text)
            ) {
                aliases.add(node.name.text);
                changed = true;
            }
            if (
                ts.isBinaryExpression(node)
                && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
                && ts.isIdentifier(unwrapExpression(node.left))
                && ts.isIdentifier(unwrapExpression(node.right))
                && aliases.has(unwrapExpression(node.right).text)
                && !aliases.has(unwrapExpression(node.left).text)
            ) {
                aliases.add(unwrapExpression(node.left).text);
                changed = true;
            }
            ts.forEachChild(node, visit);
        };
        ts.forEachChild(scope, visit);
    }

    // A shadowed variable with the same name must not be treated as the payload alias.
    return new Set([...aliases].filter((name) => {
        if (name === payloadIdentifier.text) return true;
        return declarations.some((declaration) => declaration.name === name && declaration.scope === scope);
    }));
}

function isAliasIdentifier(node, aliases) {
    return ts.isIdentifier(unwrapExpression(node)) && aliases.has(unwrapExpression(node).text);
}

function analyzeIdentifierPayload(sourceFile, payloadIdentifier, mutationCall, declarations) {
    const fields = new Set();
    const unresolvedReasons = new Set();
    const payloadDeclaration = resolveVariableDeclaration(payloadIdentifier, declarations);
    if (!payloadDeclaration?.initializer) {
        unresolvedReasons.add(`payload:${payloadIdentifier.text}:declaration-not-resolved`);
        return { fields, unresolvedReasons };
    }

    const initializer = unwrapExpression(payloadDeclaration.initializer);
    if (ts.isObjectLiteralExpression(initializer) || ts.isArrayLiteralExpression(initializer)) {
        analyzeObjectPayload(initializer, fields, unresolvedReasons, `payload:${payloadIdentifier.text}:initializer`);
    } else if (!ts.isIdentifier(initializer)) {
        unresolvedReasons.add(`payload:${payloadIdentifier.text}:initializer-not-object`);
    }

    const aliases = aliasNamesForPayload(sourceFile, payloadIdentifier, declarations, mutationCall);
    const scope = enclosingFunction(mutationCall);
    const mutationStart = mutationCall.getStart(sourceFile);

    const visit = (node) => {
        if (ts.isFunctionLike(node) && node !== scope) return;

        if (
            ts.isBinaryExpression(node)
            && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
            && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
        ) {
            const receiver = receiverIdentifier(node.left);
            if (receiver && aliases.has(receiver.text)) {
                const field = propertyNameFromAssignmentTarget(node.left);
                if (field) fields.add(field);
                else unresolvedReasons.add(`payload:${receiver.text}:dynamic-assignment-key`);
            }
        }

        if (ts.isCallExpression(node) && node !== mutationCall) {
            const path = callPath(node);
            const firstArgumentIsAlias = node.arguments.length > 0 && isAliasIdentifier(node.arguments[0], aliases);
            if (path === 'Object.assign' && firstArgumentIsAlias) {
                for (const argument of node.arguments.slice(1)) {
                    analyzeObjectPayload(argument, fields, unresolvedReasons, 'payload:Object.assign');
                }
            } else if (path === 'Reflect.set' && firstArgumentIsAlias) {
                const field = staticString(node.arguments[1]);
                if (field) fields.add(field);
                else unresolvedReasons.add('payload:Reflect.set:dynamic-key');
            } else if (path === 'Object.defineProperty' && firstArgumentIsAlias) {
                const field = staticString(node.arguments[1]);
                if (field) fields.add(field);
                else unresolvedReasons.add('payload:Object.defineProperty:dynamic-key');
            } else {
                const aliasArguments = node.arguments.filter((argument) => isAliasIdentifier(argument, aliases));
                if (aliasArguments.length > 0 && !SAFE_PAYLOAD_INSPECTIONS.has(path ?? '')) {
                    unresolvedReasons.add(`payload:helper-escape:${path ?? 'unknown-call'}`);
                }
            }
        }

        ts.forEachChild(node, visit);
    };
    ts.forEachChild(scope, visit);

    // A mutation payload may only be influenced before the database call. Later writes are
    // harmless for this occurrence, but retaining them would create false positives.
    for (const reason of [...unresolvedReasons]) {
        const marker = reason.match(/@([0-9]+)$/);
        if (marker && Number(marker[1]) > mutationStart) unresolvedReasons.delete(reason);
    }

    return { fields, unresolvedReasons };
}

function analyzeMutationPayload(sourceFile, mutationCall, operation, declarations) {
    if (operation === 'delete') {
        return { fields: [], unresolvedReasons: [] };
    }
    const argument = mutationCall.arguments[0];
    if (!argument) {
        return { fields: [], unresolvedReasons: ['payload:missing'] };
    }
    const current = unwrapExpression(argument);
    const fields = new Set();
    const unresolvedReasons = new Set();
    if (ts.isIdentifier(current)) {
        const analyzed = analyzeIdentifierPayload(sourceFile, current, mutationCall, declarations);
        for (const field of analyzed.fields) fields.add(field);
        for (const reason of analyzed.unresolvedReasons) unresolvedReasons.add(reason);
    } else if (ts.isObjectLiteralExpression(current) || ts.isArrayLiteralExpression(current)) {
        analyzeObjectPayload(current, fields, unresolvedReasons, 'payload:direct');
    } else {
        unresolvedReasons.add('payload:call-or-dynamic-expression');
    }
    return {
        fields: [...fields].sort(bytewiseCompare),
        unresolvedReasons: [...unresolvedReasons].sort(bytewiseCompare),
    };
}

function globalLinkFieldWrites(sourceFile, relativePath, sourceFileSha256) {
    const writes = [];
    const add = (node, field, kind) => {
        if (!PROPERTY_LINK_FIELDS.has(field)) return;
        writes.push({
            path: relativePath,
            line: lineAt(sourceFile, node),
            field,
            kind,
            sourceFileSha256,
        });
    };

    const visit = (node) => {
        if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
            add(node, objectPropertyName(node), 'object-property');
        } else if (
            ts.isBinaryExpression(node)
            && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
            && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
        ) {
            add(node, propertyNameFromAssignmentTarget(node.left), 'assignment');
        } else if (ts.isCallExpression(node)) {
            const path = callPath(node);
            if (path === 'Reflect.set' || path === 'Object.defineProperty') {
                add(node, staticString(node.arguments[1]), path);
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return writes;
}

function scanSourceText(source, relativePath) {
    const sourceFileSha256 = sha256(source);
    const scriptKind = /\.[jt]sx$/.test(relativePath) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sourceFile = ts.createSourceFile(
        relativePath,
        source,
        ts.ScriptTarget.Latest,
        true,
        scriptKind,
    );
    const declarations = collectVariableDeclarations(sourceFile);
    const propertyUnitMutations = [];
    const buildingMutations = [];
    const rpcCalls = [];
    const unresolved = [];
    const forbiddenAccesses = [];
    const seenMutationCalls = new Set();
    const seenRpcCalls = new Set();

    const recordMutation = (mutationCall, operation, table, reasonPrefix = null) => {
        if (seenMutationCalls.has(mutationCall)) return;
        seenMutationCalls.add(mutationCall);
        const payload = analyzeMutationPayload(sourceFile, mutationCall, operation, declarations);
        const occurrence = createOccurrence({
            kind: 'property-units-mutation',
            path: relativePath,
            line: lineAt(sourceFile, mutationCall),
            operation,
            context: contextFor(sourceFile, mutationCall),
            sourceFileSha256,
        });
        const fields = payload.fields;
        const linkFields = fields.filter((field) => PROPERTY_LINK_FIELDS.has(field));
        const dongHoFields = fields.filter((field) => PROPERTY_DONG_HO_FIELDS.has(field));
        propertyUnitMutations.push({
            ...occurrence,
            table: table ?? 'dynamic',
            fields,
            linkFields,
            dongHoFields,
            unresolvedPayloadReasons: payload.unresolvedReasons,
        });
        if (reasonPrefix) {
            unresolved.push({
                path: relativePath,
                line: lineAt(sourceFile, mutationCall),
                reason: reasonPrefix,
            });
        }
    };

    const recordBuildingMutation = (mutationCall, operation, table) => {
        if (seenMutationCalls.has(mutationCall)) return;
        seenMutationCalls.add(mutationCall);
        const payload = analyzeMutationPayload(sourceFile, mutationCall, operation, declarations);
        buildingMutations.push({
            ...createOccurrence({
                kind: 'building-family-mutation',
                path: relativePath,
                line: lineAt(sourceFile, mutationCall),
                operation,
                context: contextFor(sourceFile, mutationCall),
                sourceFileSha256,
            }),
            table,
            fields: payload.fields,
            unresolvedPayloadReasons: payload.unresolvedReasons,
        });
    };

    const visit = (node) => {
        if (
            ts.isCallExpression(node)
            && isMethodCall(node, 'from')
            && callPath(node) !== 'Array.from'
        ) {
            const table = staticString(node.arguments[0]);
            const chained = chainCallsAfter(node);
            const dynamicMethod = chained.find(({ method }) => method === null);
            const operationEntry = chained.find(({ method }) => method && WRITE_OPERATIONS.has(method));
            const readEntry = chained.find(({ method }) => method && READ_OPERATIONS.has(method));

            if (table && FORBIDDEN_TABLE_SCOPES.get(relativePath)?.has(table)) {
                forbiddenAccesses.push({
                    path: relativePath,
                    line: lineAt(sourceFile, node),
                    reason: `forbidden-table-access:${table}`,
                });
            }

            if (operationEntry) {
                if (table === 'property_units') {
                    recordMutation(operationEntry.call, operationEntry.method, table);
                } else if (table && BUILDING_TABLES.has(table)) {
                    recordBuildingMutation(operationEntry.call, operationEntry.method, table);
                } else if (!table) {
                    recordMutation(
                        operationEntry.call,
                        operationEntry.method,
                        table,
                        'dynamic-table-write-could-target-property_units',
                    );
                }
            } else if (table === 'property_units' && (dynamicMethod || !readEntry)) {
                unresolved.push({
                    path: relativePath,
                    line: lineAt(sourceFile, node),
                    reason: dynamicMethod
                        ? 'dynamic-property_units-query-builder-operation'
                        : 'property_units-query-builder-escaped-without-inline-operation',
                });
            } else if (table && BUILDING_TABLES.has(table) && (dynamicMethod || !readEntry)) {
                unresolved.push({
                    path: relativePath,
                    line: lineAt(sourceFile, node),
                    reason: dynamicMethod
                        ? 'dynamic-building-query-builder-operation'
                        : 'building-query-builder-escaped-without-inline-operation',
                });
            } else if (!table && (dynamicMethod || !readEntry)) {
                unresolved.push({
                    path: relativePath,
                    line: lineAt(sourceFile, node),
                    reason: dynamicMethod
                        ? 'dynamic-table-and-operation-not-resolved'
                        : 'dynamic-table-query-builder-escaped-without-inline-operation',
                });
            }
        }

        if (ts.isCallExpression(node)) {
            const expression = unwrapExpression(node.expression);
            const method = (
                ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)
            ) ? staticPropertyName(expression) : null;

            if (method && WRITE_OPERATIONS.has(method)) {
                const receiver = (
                    ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)
                ) ? leftmostReceiverIdentifier(expression.expression) : null;
                const origin = receiver && builderOriginForIdentifier(receiver, declarations);
                if (origin?.table === 'property_units') {
                    recordMutation(node, method, origin.table);
                } else if (origin?.table && BUILDING_TABLES.has(origin.table)) {
                    recordBuildingMutation(node, method, origin.table);
                } else if (origin && !origin.table) {
                    recordMutation(node, method, null, 'dynamic-builder-alias-write-could-target-property_units');
                }
            } else if (
                (ts.isElementAccessExpression(expression) && staticPropertyName(expression) === null)
                && leftmostReceiverIdentifier(expression.expression)
            ) {
                const receiver = leftmostReceiverIdentifier(expression.expression);
                const origin = receiver && builderOriginForIdentifier(receiver, declarations);
                if (
                    origin?.table === 'property_units'
                    || (origin?.table && BUILDING_TABLES.has(origin.table))
                    || (origin && !origin.table)
                ) {
                    unresolved.push({
                        path: relativePath,
                        line: lineAt(sourceFile, node),
                        reason: 'dynamic-builder-alias-operation-not-resolved',
                    });
                }
            }

            if (isMethodCall(node, 'rpc') && !seenRpcCalls.has(node)) {
                seenRpcCalls.add(node);
                const name = staticString(node.arguments[0]);
                if (!name) {
                    unresolved.push({
                        path: relativePath,
                        line: lineAt(sourceFile, node),
                        reason: 'dynamic-rpc-name-not-allowed',
                    });
                } else {
                    rpcCalls.push(createOccurrence({
                        kind: 'rpc-call',
                        path: relativePath,
                        line: lineAt(sourceFile, node),
                        name,
                        context: contextFor(sourceFile, node),
                        sourceFileSha256,
                    }));
                }
            }

            if (ts.isElementAccessExpression(expression) && staticPropertyName(expression) === null) {
                const firstArgument = staticString(node.arguments[0]);
                const followedByWrite = chainCallsAfter(node)
                    .some(({ method: chainedMethod }) => chainedMethod && WRITE_OPERATIONS.has(chainedMethod));
                if (
                    firstArgument === 'property_units'
                    || (firstArgument !== null && BUILDING_TABLES.has(firstArgument))
                    || followedByWrite
                ) {
                    unresolved.push({
                        path: relativePath,
                        line: lineAt(sourceFile, node),
                        reason: 'dynamic-data-client-method-not-allowed',
                    });
                }
            }

            if (callPath(node) === 'Reflect.get') {
                const reflectedMethod = staticString(node.arguments[1]);
                if (reflectedMethod === 'from' || reflectedMethod === 'rpc') {
                    unresolved.push({
                        path: relativePath,
                        line: lineAt(sourceFile, node),
                        reason: `reflect-get-${reflectedMethod}-method-not-allowed`,
                    });
                }
            }
        }

        if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
            const extractedMethod = staticPropertyName(node);
            if (extractedMethod === 'from' || extractedMethod === 'rpc') {
                const receiver = unwrapExpression(node.expression);
                const isArrayFrom = extractedMethod === 'from'
                    && ts.isIdentifier(receiver)
                    && receiver.text === 'Array';
                const isDirectInvocation = ts.isCallExpression(node.parent)
                    && node.parent.expression === node;
                if (!isArrayFrom && !isDirectInvocation) {
                    unresolved.push({
                        path: relativePath,
                        line: lineAt(sourceFile, node),
                        reason: `extracted-${extractedMethod}-method-not-allowed`,
                    });
                }
            }
        }

        if (ts.isBindingElement(node)) {
            const property = bindingPropertyName(node);
            if (property === 'from' || property === 'rpc') {
                unresolved.push({
                    path: relativePath,
                    line: lineAt(sourceFile, node),
                    reason: `destructured-${property}-reference-not-allowed`,
                });
            }
        }

        if (
            ts.isBinaryExpression(node)
            && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
            && ts.isObjectLiteralExpression(unwrapExpression(node.left))
        ) {
            const assignmentPattern = unwrapExpression(node.left);
            for (const property of assignmentPattern.properties) {
                const propertyName = assignmentBindingPropertyName(property);
                if (propertyName === 'from' || propertyName === 'rpc') {
                    unresolved.push({
                        path: relativePath,
                        line: lineAt(sourceFile, property),
                        reason: `assignment-destructured-${propertyName}-reference-not-allowed`,
                    });
                }
            }
        }

        if (ts.isCallExpression(node) && isMethodCall(node, 'bind')) {
            const expression = unwrapExpression(node.expression);
            const target = (
                ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)
            ) ? unwrapExpression(expression.expression) : null;
            if (target && ts.isElementAccessExpression(target) && staticString(target.argumentExpression) === null) {
                unresolved.push({
                    path: relativePath,
                    line: lineAt(sourceFile, node),
                    reason: 'dynamic-bound-method-not-allowed',
                });
            }
        }

        const forbiddenIdentifiers = FORBIDDEN_IDENTIFIER_SCOPES.get(relativePath);
        if (forbiddenIdentifiers && ts.isIdentifier(node) && forbiddenIdentifiers.has(node.text)) {
            forbiddenAccesses.push({
                path: relativePath,
                line: lineAt(sourceFile, node),
                reason: `forbidden-identifier:${node.text}`,
            });
        }

        ts.forEachChild(node, visit);
    };
    visit(sourceFile);

    return {
        propertyUnitMutations,
        buildingMutations,
        rpcCalls,
        unresolved,
        forbiddenAccesses,
        globalLinkFieldWrites: globalLinkFieldWrites(sourceFile, relativePath, sourceFileSha256),
    };
}

async function listSourceFiles(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
            files.push(...await listSourceFiles(path));
        } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.slice(path.lastIndexOf('.')))) {
            files.push(path);
        }
    }
    return files.sort(bytewiseCompare);
}

function sortOccurrences(entries) {
    return entries.sort((left, right) => bytewiseCompare(
        [left.path, String(left.line).padStart(8, '0'), left.id ?? '', left.reason ?? ''].join('\0'),
        [right.path, String(right.line).padStart(8, '0'), right.id ?? '', right.reason ?? ''].join('\0'),
    ));
}

async function buildInventory(repoRoot = DEFAULT_REPO_ROOT) {
    const sourceRoot = resolve(repoRoot, 'src');
    const files = await listSourceFiles(sourceRoot);
    const inventory = {
        propertyUnitMutations: [],
        buildingMutations: [],
        rpcCalls: [],
        unresolved: [],
        forbiddenAccesses: [],
        globalLinkFieldWrites: [],
    };
    for (const absolutePath of files) {
        const relativePath = relative(repoRoot, absolutePath).split('\\').join('/');
        const source = await readFile(absolutePath, 'utf8');
        const scanned = scanSourceText(source, relativePath);
        for (const key of Object.keys(inventory)) inventory[key].push(...scanned[key]);
    }
    for (const key of Object.keys(inventory)) sortOccurrences(inventory[key]);
    return inventory;
}

function validatePolicyShape(policy) {
    const errors = [];
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
        return ['policy는 JSON object여야 합니다.'];
    }
    if (policy.formatVersion !== 1) errors.push('policy.formatVersion은 1이어야 합니다.');
    if (!Array.isArray(policy.propertyUnitWriters)) errors.push('policy.propertyUnitWriters는 배열이어야 합니다.');
    if (!Array.isArray(policy.buildingWriters)) errors.push('policy.buildingWriters는 배열이어야 합니다.');
    if (!Array.isArray(policy.rpcCalls)) errors.push('policy.rpcCalls는 배열이어야 합니다.');
    return errors;
}

function comparePolicyEntries({ actual, allowed, label, fields }) {
    const errors = [];
    const actualById = new Map();
    for (const entry of actual) {
        if (actualById.has(entry.id)) errors.push(`${label} actual id가 중복되었습니다: ${entry.id}`);
        actualById.set(entry.id, entry);
    }
    const allowedIds = new Set();
    for (const [index, entry] of allowed.entries()) {
        const prefix = `${label}[${index}]`;
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            errors.push(`${prefix}는 object여야 합니다.`);
            continue;
        }
        if (!/^[0-9a-f]{20}$/.test(entry.id ?? '')) errors.push(`${prefix}.id가 유효하지 않습니다.`);
        if (allowedIds.has(entry.id)) errors.push(`${prefix}.id가 중복되었습니다: ${entry.id}`);
        allowedIds.add(entry.id);
        for (const field of ['contextSha256', 'sourceFileSha256']) {
            if (!/^[0-9a-f]{64}$/.test(entry[field] ?? '')) errors.push(`${prefix}.${field}가 유효하지 않습니다.`);
        }
        for (const field of ['owner', 'rationale']) {
            if (typeof entry[field] !== 'string' || entry[field].trim().length === 0) {
                errors.push(`${prefix}.${field}가 비어 있습니다.`);
            }
        }

        const matched = actualById.get(entry.id);
        if (!matched) {
            errors.push(`stale ${label} policy entry입니다: ${entry.id}`);
            continue;
        }
        for (const field of fields) {
            if (JSON.stringify(entry[field]) !== JSON.stringify(matched[field])) {
                errors.push(`${prefix}.${field}가 inventory와 다릅니다: ${JSON.stringify(matched[field])}`);
            }
        }
    }
    for (const entry of actual) {
        if (!allowedIds.has(entry.id)) {
            errors.push(`미승인 ${label}가 있습니다: ${entry.path}:${entry.line}:${entry.id}`);
        }
    }
    return errors;
}

function validateInventoryAgainstPolicy(inventory, policy) {
    const errors = validatePolicyShape(policy);

    for (const mutation of inventory.propertyUnitMutations) {
        if (mutation.table !== 'property_units') {
            errors.push(
                `동적 table writer는 property_units를 가리킬 수 있어 금지됩니다: `
                + `${mutation.path}:${mutation.line}:${mutation.operation}`,
            );
        }
        if (mutation.linkFields.length > 0) {
            errors.push(
                `property-building 자동 link writer는 0건이어야 합니다: `
                + `${mutation.path}:${mutation.line}:${mutation.linkFields.join(',')}`,
            );
        }
        for (const reason of mutation.unresolvedPayloadReasons) {
            errors.push(`property_units payload를 확정할 수 없습니다: ${mutation.path}:${mutation.line}:${reason}`);
        }
    }
    for (const mutation of inventory.buildingMutations) {
        if (!BUILDING_TABLES.has(mutation.table)) {
            errors.push(`building-family writer table을 확정할 수 없습니다: ${mutation.path}:${mutation.line}`);
        }
    }
    for (const entry of inventory.globalLinkFieldWrites) {
        errors.push(
            `building link field write는 Phase F 전까지 금지됩니다: `
            + `${entry.path}:${entry.line}:${entry.field}:${entry.kind}`,
        );
    }
    for (const entry of inventory.unresolved) {
        errors.push(`정적 분석 escape를 허용하지 않습니다: ${entry.path}:${entry.line}:${entry.reason}`);
    }
    for (const entry of inventory.forbiddenAccesses) {
        errors.push(`scope 경계를 위반했습니다: ${entry.path}:${entry.line}:${entry.reason}`);
    }

    errors.push(...comparePolicyEntries({
        actual: inventory.propertyUnitMutations,
        allowed: policy?.propertyUnitWriters ?? [],
        label: 'property_units writer',
        fields: [
            'path',
            'table',
            'operation',
            'contextSha256',
            'sourceFileSha256',
            'fields',
            'dongHoFields',
        ],
    }));
    errors.push(...comparePolicyEntries({
        actual: inventory.buildingMutations,
        allowed: policy?.buildingWriters ?? [],
        label: 'building-family writer',
        fields: [
            'path',
            'table',
            'operation',
            'contextSha256',
            'sourceFileSha256',
        ],
    }));
    errors.push(...comparePolicyEntries({
        actual: inventory.rpcCalls,
        allowed: policy?.rpcCalls ?? [],
        label: 'RPC call',
        fields: ['path', 'name', 'contextSha256', 'sourceFileSha256'],
    }));

    for (const [index, writer] of (policy?.propertyUnitWriters ?? []).entries()) {
        const expectedClassification = (writer.dongHoFields ?? []).length > 0
            ? 'PROPERTY_OWNED_INPUT'
            : 'NONE';
        if (writer.dongHoClassification !== expectedClassification) {
            errors.push(
                `property_units writer[${index}].dongHoClassification은 `
                + `${expectedClassification}이어야 합니다.`,
            );
        }
    }

    if (errors.length > 0) {
        throw new Error(`Phase 0-S property-building writer guard failed:\n- ${errors.join('\n- ')}`);
    }
    return {
        propertyUnitWriterCount: inventory.propertyUnitMutations.length,
        buildingWriterCount: inventory.buildingMutations.length,
        propertyBuildingWriterCount: 0,
        rpcCallCount: inventory.rpcCalls.length,
    };
}

async function findPropertyBuildingLinkWriterViolations({
    repoRoot = DEFAULT_REPO_ROOT,
    policyPath = DEFAULT_POLICY_PATH,
} = {}) {
    const inventory = await buildInventory(repoRoot);
    let policy;
    try {
        policy = JSON.parse(await readFile(resolve(repoRoot, policyPath), 'utf8'));
    } catch (error) {
        return [`${policyPath}: policy를 읽을 수 없습니다: ${error.message}`];
    }

    const memberRoute = await readFile(resolve(repoRoot, 'src/routes/member.ts'), 'utf8');
    const routeViolations = [];
    if (!memberRoute.includes("code: 'FEATURE_DISABLED_PHASE_F'")) {
        routeViolations.push('src/routes/member.ts: SYNC_PROPERTIES feature-disabled response is missing');
    }
    if (!memberRoute.includes('return res.status(409).json')) {
        routeViolations.push('src/routes/member.ts: SYNC_PROPERTIES must return HTTP 409');
    }

    try {
        validateInventoryAgainstPolicy(inventory, policy);
        return routeViolations;
    } catch (error) {
        return [...routeViolations, error.message];
    }
}

async function main() {
    if (process.argv.includes('--print-inventory')) {
        console.log(JSON.stringify(await buildInventory(DEFAULT_REPO_ROOT), null, 2));
        return;
    }
    const violations = await findPropertyBuildingLinkWriterViolations();
    if (violations.length > 0) {
        console.error(violations.join('\n'));
        process.exitCode = 1;
    } else {
        console.log('Phase 0-S property-building writer guard passed.');
    }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === SCRIPT_PATH) {
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}

export {
    buildInventory,
    findPropertyBuildingLinkWriterViolations,
    scanSourceText,
    validateInventoryAgainstPolicy,
};
