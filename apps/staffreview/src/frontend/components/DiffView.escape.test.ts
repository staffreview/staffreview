import { expect, test } from "bun:test";
import { escapeHtml, escapeHtmlAttr } from "./DiffView.tsx";

// --- Faithful copies of react-diff-viewer-continued's internals -------------
//
// `decodeEntities` and `applyDiffToHighlightedHtml` are NOT exported by the
// library, so we mirror them here. The escaped HTML we hand the library is only
// correct if our escaping stays in lock-step with these two functions, so the
// copies double as a contract test: if a library upgrade changes the decode set
// or order, these tests (and `escapeHtml`) must change together.
//
// Source: react-diff-viewer-continued@4.2.2, lib/esm/src/index.js
//   - decodeEntities: replacements run SEQUENTIALLY, `&amp;`→`&` BEFORE the
//     `&quot;`/`&#39;`/`&#x27;`/`&nbsp;` rules (the bug thread #1 is about).
//   - applyDiffToHighlightedHtml: splits HTML into tag/text segments on
//     `<`…`>` and decodes each TEXT segment independently.
function decodeEntities(text: string): string {
	return text
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&#x27;/g, "'")
		.replace(/&nbsp;/g, " ");
}

// The character count the library actually walks against the word-diff ranges:
// it sums `decodeEntities(segment).length` over the TEXT segments only (tags are
// skipped). This is exactly how `escapeHtml` output is consumed on a CHANGED
// line, so it is the right oracle for the `decoded.length === raw.length`
// property — and it is what `<wbr>` tag boundaries rely on.
function librarySegmentDecodedLength(html: string): number {
	let i = 0;
	let total = 0;
	while (i < html.length) {
		if (html[i] === "<") {
			const tagEnd = html.indexOf(">", i);
			if (tagEnd === -1) {
				total += decodeEntities(html.slice(i)).length;
				break;
			}
			i = tagEnd + 1; // skip the tag
		} else {
			let textEnd = html.indexOf("<", i);
			if (textEnd === -1) textEnd = html.length;
			total += decodeEntities(html.slice(i, textEnd)).length;
			i = textEnd;
		}
	}
	return total;
}

// --- escapeHtml: the five-entity injection-safety set (thread #2) ------------

test("escapeHtml escapes all five HTML-significant characters", () => {
	expect(escapeHtml("<")).toBe("&lt;");
	expect(escapeHtml(">")).toBe("&gt;");
	expect(escapeHtml("&")).toBe("&amp;");
	expect(escapeHtml('"')).toBe("&quot;");
	expect(escapeHtml("'")).toBe("&#39;");
});

test("escapeHtml neutralizes a script-injection attempt", () => {
	const out = escapeHtml(`</span><img src=x onerror="alert(1)">`);
	expect(out).not.toContain("<img");
	expect(out).not.toContain("</span>");
	// No raw `<` or `>` survive; quotes are entitized too.
	expect(out).toBe(
		"&lt;/span&gt;&lt;img src=x onerror=&quot;alert(1)&quot;&gt;",
	);
});

test("escapeHtml escapes & before < and > (no double-encoding)", () => {
	// `&` must be replaced first; otherwise the `&` introduced by `&lt;`/`&gt;`
	// would itself be re-escaped to `&amp;lt;`.
	expect(escapeHtml("<&>")).toBe("&lt;&amp;&gt;");
	expect(escapeHtml("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
});

// --- escapeHtmlAttr (thread #2) ----------------------------------------------

test("escapeHtmlAttr escapes & and \" only", () => {
	expect(escapeHtmlAttr('color:"red"&blue')).toBe(
		"color:&quot;red&quot;&amp;blue",
	);
	// `<`/`>`/`'` are not special inside a double-quoted attribute value.
	expect(escapeHtmlAttr("a<b>c'd")).toBe("a<b>c'd");
});

test("escapeHtmlAttr escapes & before \" (no double-encoding)", () => {
	expect(escapeHtmlAttr('&"')).toBe("&amp;&quot;");
});

// --- Decoder-sync / decoded.length === raw.length (threads #1 + #2) ----------
//
// These inputs reproduce thread #1's bug: a source line literally containing one
// of the library's `&amp;`-and-after entities. Before the fix, `escapeHtml`
// produced `&amp;#39;` / `&amp;nbsp;` / `&amp;#x27;` / `&amp;quot;`, which the
// library's `decodeEntities` collapses (`&amp;`→`&`, then the body) so the
// decoded length undercounts the raw length by 4–5 chars and the word-diff
// overlay drifts. The `<wbr>` tag boundary keeps the decoded `&` and the body in
// separate segments so they can't re-combine.
const DECODER_SYNC_INPUTS = [
	"plain ascii line",
	"a < b && c > d",
	`name="value"`,
	"it's a 'quoted' string",
	"&", // bare ampersand
	"&#39;", // <- thread #1 repro
	"&nbsp;", // <- thread #1 repro
	"&#x27;", // <- thread #1 repro
	"&quot;", // <- thread #1 repro
	"a&#39;b", // <- thread #1 repro (embedded)
	"&lt;", // safe: &lt; decoded before &amp;
	"&gt;", // safe: &gt; decoded before &amp;
	"&amp;", // safe: &amp;amp; decodes to &amp;
	"x &nbsp; y &#39; z &quot; w", // mixed, realistic HTML
	`<a href="x">&#39;</a>`,
	"&amp;#39;", // double-escaped source text
];

for (const raw of DECODER_SYNC_INPUTS) {
	test(`decoded length matches raw length for ${JSON.stringify(raw)}`, () => {
		const escaped = escapeHtml(raw);
		expect(librarySegmentDecodedLength(escaped)).toBe(raw.length);
	});
}

test("the <wbr> fix is exactly what keeps the re-formable entities in sync", () => {
	// Sanity check that the bug is real: without the tag boundary, a flat decode
	// of the naively-escaped string undercounts. This documents WHY the fix
	// exists and would fail if someone reverted to the plain escape.
	const raw = "&#39;";
	const naivelyEscaped = "&amp;#39;"; // what the pre-fix escapeHtml emitted
	expect(decodeEntities(naivelyEscaped).length).toBe(1); // the bug: 1 ≠ 5
	expect(librarySegmentDecodedLength(escapeHtml(raw))).toBe(raw.length);
});
