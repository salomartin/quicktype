/* eslint-disable */

import { arrayIntercalate } from "collection-utils";

import { ConvenienceRenderer } from "../../ConvenienceRenderer";
import { type Name, type Namer, funPrefixNamer } from "../../Naming";
import { type RenderContext } from "../../Renderer";
import { type OptionValues } from "../../RendererOptions";
import { type Sourcelike } from "../../Source";
import { AcronymStyleOptions, acronymStyle } from "../../support/Acronyms";
import {
    allLowerWordStyle,
    capitalize,
    combineWords,
    firstUpperWordStyle,
    isLetterOrUnderscore,
    splitIntoWords,
    stringEscape,
    utf16StringEscape
} from "../../support/Strings";
import { defined, panic } from "../../support/Support";
import { type TargetLanguage } from "../../TargetLanguage";
import {
    ArrayType,
    type ClassProperty,
    ClassType,
    type EnumType,
    ObjectType,
    SetOperationType,
    type Type
} from "../../Type";
import { matchType } from "../../TypeUtils";
import { legalizeName } from "../JavaScript/utils";

import { type typeScriptZodOptions } from "./language";

/**
 * A renderer for outputting TypeScript + Zod schemas.
 *
 * IMPORTANT:
 * - For **recursive/cyclical** references, we define the schema in **one statement** with `z.lazy`.
 * - This avoids "Block-scoped variable used before its declaration" TypeScript errors.
 */
export class TypeScriptZodRenderer extends ConvenienceRenderer {
    public constructor(
        targetLanguage: TargetLanguage,
        renderContext: RenderContext,
        protected readonly _options: OptionValues<typeof typeScriptZodOptions>
    ) {
        super(targetLanguage, renderContext);
    }

    protected forbiddenNamesForGlobalNamespace(): string[] {
        return ["Class", "Date", "Object", "String", "Array", "JSON", "Error"];
    }

    /**
     * Converts a raw string to a legal TypeScript identifier by splitting into words,
     * applying camel/capitalization rules, and replacing illegal characters.
     */
    protected nameStyle(original: string, upper: boolean): string {
        const acronyms = acronymStyle(AcronymStyleOptions.Camel);
        const words = splitIntoWords(original);
        return combineWords(
            words,
            legalizeName,
            upper ? firstUpperWordStyle : allLowerWordStyle,
            firstUpperWordStyle,
            upper ? (s: string): string => capitalize(acronyms(s)) : allLowerWordStyle,
            acronyms,
            "",
            isLetterOrUnderscore
        );
    }

    /**
     * Namer for top-level classes, or named object types.
     */
    protected makeNamedTypeNamer(): Namer {
        return funPrefixNamer("types", s => this.nameStyle(s, true));
    }

    /**
     * Namer for union members.
     */
    protected makeUnionMemberNamer(): Namer {
        return funPrefixNamer("properties", s => this.nameStyle(s, true));
    }

    /**
     * Namer for object properties.
     */
    protected namerForObjectProperty(): Namer {
        return funPrefixNamer("properties", s => this.nameStyle(s, true));
    }

    /**
     * Namer for enum cases.
     */
    protected makeEnumCaseNamer(): Namer {
        return funPrefixNamer("enum-cases", s => this.nameStyle(s, false));
    }

    /**
     * Utility to generate an import statement.
     */
    protected importStatement(lhs: Sourcelike, moduleName: Sourcelike): Sourcelike {
        return ["import ", lhs, " from ", moduleName, ";"];
    }

    /**
     * Emit the necessary `import` lines.
     */
    protected emitImports(): void {
        this.ensureBlankLine();
        this.emitLine(this.importStatement("* as z", '"zod"'));
    }

    /**
     * Generate the Zod type expression for a property, handling optionality.
     * We use a spread when emitting to flatten arrays properly.
     */
    protected typeMapTypeForProperty(p: ClassProperty): Sourcelike {
        const requiredPart = this.typeMapTypeFor(p.type);
        if (p.isOptional) {
            // e.g. ["z.any()", ".optional()"]
            return [...(Array.isArray(requiredPart) ? requiredPart : [requiredPart]), ".optional()"];
        }
        return requiredPart;
    }

    /**
     * Generate the Zod type expression for a given Type (string, number, union, etc.).
     * We return a "Sourcelike array" that can be flattened in `emitLine(...)`.
     */
    protected typeMapTypeFor(t: Type): Sourcelike {
        // If it's a named type (class/object/enum), produce e.g. `[Name, "Schema"]`
        if (t.kind === "class" || t.kind === "object" || t.kind === "enum") {
            // Will flatten to something like "MyTypeSchema"
            return [this.nameForNamedType(t), "Schema"];
        }

        // Otherwise handle built-ins, arrays, unions, etc.
        return matchType<Sourcelike>(
            t,
            _anyType => "z.any()",
            _nullType => "z.null()",
            _boolType => "z.boolean()",
            _integerType => "z.number()",
            _doubleType => "z.number()",
            _stringType => "z.string()",
            arrayType => {
                const itemType = this.typeMapTypeFor(arrayType.items);
                // Flatten itemType in final code: "z.array( <itemType> )"
                return ["z.array(", ...(Array.isArray(itemType) ? itemType : [itemType]), ")"];
            },
            _classType => panic("Should already be handled via named type reference."),
            mapType => {
                // "z.record(z.string(), <valueType>)"
                const valueType = this.typeMapTypeFor(mapType.values);
                return ["z.record(z.string(), ", ...(Array.isArray(valueType) ? valueType : [valueType]), ")"];
            },
            _enumType => panic("Should already be handled via named type reference."),
            unionType => {
                // "z.union([ ...children ])"
                const children = Array.from(unionType.getChildren()).map((child: Type) => {
                    const childSL = this.typeMapTypeFor(child);
                    return Array.isArray(childSL) ? childSL : [childSL];
                });
                return ["z.union([", ...arrayIntercalate<Sourcelike>(", ", children), "])"];
            },
            _transformedStringType => {
                // For date-time, quicktype uses "date-time", etc.
                // We'll coerce if it's date-time
                if (_transformedStringType.kind === "date-time") {
                    return "z.coerce.date()";
                }
                return "z.string()";
            }
        );
    }

    /**
     * Emit a non-recursive (non-cyclical) object's Zod schema.
     */
    protected emitObject(name: Name, t: ObjectType): void {
        this.ensureBlankLine();
        // Flatten the name to something like "FooSchema"
        const schemaName: Sourcelike = [name, "Schema"];

        this.emitLine("export const ", schemaName, " = z.object({");
        this.indent(() => {
            this.forEachClassProperty(t, "none", (_, jsonName, property) => {
                const propertySL = this.typeMapTypeForProperty(property);
                this.emitLine(`"${utf16StringEscape(jsonName)}": `, ...[propertySL], ",");
            });
        });
        this.emitLine("});");

        if (!this._options.justSchema) {
            this.emitLine("export type ", name, " = z.infer<typeof ", schemaName, ">;");
        }
    }

    /**
     * Emit a Zod enum definition.
     */
    protected emitEnum(e: EnumType, enumName: Name): void {
        this.ensureBlankLine();
        this.emitDescription(this.descriptionForType(e));

        // e.g. "export const ColorSchema = z.enum([...])"
        const schemaName: Sourcelike = [enumName, "Schema"];
        this.emitLine("export const ", schemaName, " = z.enum([");
        this.indent(() => {
            this.forEachEnumCase(e, "none", (_, jsonName) => {
                this.emitLine('"', stringEscape(jsonName), '",');
            });
        });
        this.emitLine("]);");

        if (!this._options.justSchema) {
            this.emitLine("export type ", enumName, " = z.infer<typeof ", schemaName, ">;");
        }
    }

    /**
     * Emit a "lazy" object for recursive types or cyclical references.
     *
     * We define it in **one** statement so that TS doesn't complain about using the name
     * before it's declared in the same scope. For example:
     *
     * export const FooSchema = z.lazy(() => z.object({
     *   "child": FooSchema
     * }))
     *
     * That is safe in TypeScript with a single statement referencing itself via lazy.
     */
    protected emitLazyObject(name: Name, t: ObjectType): void {
        this.ensureBlankLine();
        const schemaName: Sourcelike = [name, "Schema"];

        // Single-statement approach
        // e.g.
        // export const DatumSchema = z.lazy(() => z.object({
        //   "categories": z.array(DatumSchema),
        //   ...
        // }));
        this.emitLine("export const ", schemaName, " = z.lazy(() => z.object({");
        this.indent(() => {
            this.forEachClassProperty(t, "none", (_, jsonName, property) => {
                const propertySL = this.typeMapTypeForProperty(property);
                this.emitLine(`"${utf16StringEscape(jsonName)}": `, ...[propertySL], ",");
            });
        });
        this.emitLine("}));");

        if (!this._options.justSchema) {
            this.emitLine("export type ", name, " = z.infer<typeof ", schemaName, ">;");
        }
    }

    /**
     * Build a DAG (adjacency list) describing references between object types.
     * We exclude primitives and enums from these edges.  For each object type X,
     * we find the object‐type references it depends on and add edges X -> Y in adjacency.
     */
    private static extractUnderlyingTyperefs(type: Type): number[] {
        const typeRefs: number[] = [];

        // Ignore enums and primitives in terms of generating adjacency edges
        if (type.isPrimitive() || type.kind === "enum") {
            return typeRefs;
        }

        if (type instanceof SetOperationType) {
            for (const member of type.members) {
                typeRefs.push(...TypeScriptZodRenderer.extractUnderlyingTyperefs(member));
            }
        }

        if (type instanceof ObjectType) {
            const additional = type.getAdditionalProperties();
            if (additional !== undefined) {
                typeRefs.push(...TypeScriptZodRenderer.extractUnderlyingTyperefs(additional));
            }
        }

        if (type instanceof ArrayType) {
            typeRefs.push(...TypeScriptZodRenderer.extractUnderlyingTyperefs(type.items));
        }

        // If this is actually a class or object type, include its own typeRef
        if (type instanceof ClassType || type instanceof ObjectType) {
            typeRefs.push(type.typeRef);
        }

        return typeRefs;
    }

    /**
     * Use Tarjan’s algorithm to find strongly connected components (SCCs).
     * Returns:
     *   - sccId[v] : index of the strongly-connected component that node v belongs to
     *   - sccCount : total number of SCCs found
     */
    private computeSCC(adjacency: number[][]): { sccId: number[]; sccCount: number } {
        const n = adjacency.length;
        const stack: number[] = [];
        const onStack = new Array<boolean>(n).fill(false);
        const index = new Array<number>(n).fill(-1);
        const lowLink = new Array<number>(n).fill(-1);

        let currentIndex = 0;
        let sccCount = 0;
        const sccId = new Array<number>(n).fill(-1);

        const strongConnect = (v: number) => {
            index[v] = currentIndex;
            lowLink[v] = currentIndex;
            currentIndex++;
            stack.push(v);
            onStack[v] = true;

            for (const w of adjacency[v]) {
                if (index[w] < 0) {
                    strongConnect(w);
                    lowLink[v] = Math.min(lowLink[v], lowLink[w]);
                } else if (onStack[w]) {
                    lowLink[v] = Math.min(lowLink[v], index[w]);
                }
            }

            // If v is a root node, pop the stack and generate an SCC
            if (lowLink[v] === index[v]) {
                let w: number;
                do {
                    w = stack.pop() as number;
                    onStack[w] = false;
                    sccId[w] = sccCount;
                } while (w !== v);
                sccCount++;
            }
        };

        for (let i = 0; i < n; i++) {
            if (index[i] < 0) {
                strongConnect(i);
            }
        }

        return { sccId, sccCount };
    }

    /**
     * Perform a simple DFS-based topological sort on a DAG represented by adjacency sets.
     */
    private topologicalSort(adjacency: Set<number>[]): number[] {
        const n = adjacency.length;
        const visited = new Array<boolean>(n).fill(false);
        const result: number[] = [];

        const dfs = (u: number) => {
            visited[u] = true;
            for (const v of adjacency[u]) {
                if (!visited[v]) {
                    dfs(v);
                }
            }
            result.push(u);
        };

        for (let i = 0; i < n; i++) {
            if (!visited[i]) {
                dfs(i);
            }
        }

        // The order we get is reversed postorder, so reverse it
        return result.reverse();
    }

    /**
     * Emit the objects (and any recursive variants) in a correct topological order
     * so that forward references do not appear in the generated code.
     */
    protected emitSchemas(): void {
        this.ensureBlankLine();

        // 1. Emit enumerations first
        this.forEachEnum("leading-and-interposing", (enumType: EnumType, enumName: Name) => {
            this.emitEnum(enumType, enumName);
        });

        // 2. Gather all object types
        const allObjects: ObjectType[] = [];
        const allObjectNames: Name[] = [];
        this.forEachObject("none", (obj: ObjectType, objName: Name) => {
            allObjects.push(obj);
            allObjectNames.push(objName);
        });

        // If there are no objects, we’re done
        if (allObjects.length === 0) return;

        // 3. Build adjacency list for these objects
        // Map each typeRef -> index in allObjects
        const typeRefToIndex = new Map<number, number>();
        for (let i = 0; i < allObjects.length; i++) {
            typeRefToIndex.set(allObjects[i].typeRef, i);
        }

        const adjacency: number[][] = allObjects.map(() => []);

        // For each object, find references to other object types
        for (let i = 0; i < allObjects.length; i++) {
            const t = allObjects[i];
            const childRefs = TypeScriptZodRenderer.extractUnderlyingTyperefs(t);
            for (const r of childRefs) {
                if (typeRefToIndex.has(r)) {
                    adjacency[i].push(defined(typeRefToIndex.get(r)));
                }
            }
        }

        // 4. Compute strongly connected components
        const { sccId, sccCount } = this.computeSCC(adjacency);
        // Size of each SCC
        const sccSizes = new Array<number>(sccCount).fill(0);
        for (let i = 0; i < allObjects.length; i++) {
            sccSizes[sccId[i]]++;
        }

        // Mark which objects are in a cycle or self-recursive
        const isRecursive: boolean[] = new Array(allObjects.length).fill(false);
        for (let i = 0; i < allObjects.length; i++) {
            const mySCC = sccId[i];
            // If an SCC has more than 1 node, everything in it is recursive
            if (sccSizes[mySCC] > 1) {
                isRecursive[i] = true;
            } else {
                // If it’s a single-node SCC, check for a self-edge
                if (adjacency[i].includes(i)) {
                    isRecursive[i] = true;
                }
            }
        }

        // 5. Build adjacency among SCCs, then do a topological sort on the condensed graph
        const sccAdj = Array.from({ length: sccCount }, () => new Set<number>());

        for (let i = 0; i < allObjects.length; i++) {
            const iSCC = sccId[i];
            for (const j of adjacency[i]) {
                const jSCC = sccId[j];
                if (iSCC !== jSCC) {
                    sccAdj[iSCC].add(jSCC);
                }
            }
        }
        const sccOrder = this.topologicalSort(sccAdj);

        // Expand that into actual objects in topological order
        const sortedIndices: number[] = [];
        for (const sccIndex of sccOrder) {
            // All objects that belong to sccIndex
            for (let i = 0; i < allObjects.length; i++) {
                if (sccId[i] === sccIndex) {
                    sortedIndices.push(i);
                }
            }
        }

        // 6. Emit each object type, using a single-statement lazy for anything flagged recursive
        for (const i of sortedIndices) {
            const t = allObjects[i];
            const name = allObjectNames[i];
            if (isRecursive[i]) {
                this.emitLazyObject(name, t);
            } else {
                this.emitObject(name, t);
            }
        }
    }

    /**
     * Generate the file’s structure: optional heading comments, imports, then schemas/enums.
     */
    protected emitSourceStructure(): void {
        if (this.leadingComments !== undefined) {
            this.emitComments(this.leadingComments);
        }

        this.emitImports();
        this.emitSchemas();
    }
}
