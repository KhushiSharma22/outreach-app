import {test} from 'node:test';
import assert from 'node:assert/strict';
import {formatEmail} from '../server/email-format.mjs';

test('email formatting escapes content, renders simple emphasis and bullets, and keeps unsubscribe usable',()=>{
 const url='https://app.example.com/unsubscribe/token';
 const out=formatEmail(`Hi Jo,\n\nA **short** overview:\n- First\n- Second <script>alert(1)</script>\n\nUnsubscribe: ${url}`,{unsubscribeUrl:url});
 assert.match(out.text,/A short overview/);assert.doesNotMatch(out.text,/\*\*short\*\*/);
 assert.match(out.html,/<strong>short<\/strong>/);assert.match(out.html,/<ul><li>First<\/li><li>Second &lt;script&gt;/);
 assert.doesNotMatch(out.html,/<script>/);assert.match(out.html,/<a href="https:\/\/app.example.com\/unsubscribe\/token">/);
});
