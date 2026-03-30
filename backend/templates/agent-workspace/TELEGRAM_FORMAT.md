# Telegram Formatting Cheat Sheet

Quick reference for AI agents responding in Telegram.

---

## HTML Mode (Recommended)

### Basic Formatting
```html
<b>bold</b>
<i>italic</i>
<u>underline</u>
<s>strikethrough</s>
<code>inline code</code>
<a href="https://example.com">link</a>
<pre>preformatted</pre>
```

### Code Blocks
```html
<pre><code class="language-python">
def hello():
    print("Hello, World!")
</code></pre>
```

### Combining
```html
<b>Bold with <i>italic</i> inside</b>
```

### Escaping
Only need to escape: `<`, `>`, `&`
```javascript
text.replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/&/g, '&amp;');
```

---

## MarkdownV2 Mode (Advanced)

### Basic Formatting
```
*bold*
_italic_
__underline__
~strikethrough~
||spoiler||
`inline code`
[link](https://example.com)
```

### Code Blocks
````
```python
def hello():
    print("Hello, World!")
```
````

### Escaping (CRITICAL)
Must escape: `_*[]()~`>#+-=|{}.!\`

```javascript
text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
```

### Combining
```
*bold _italic bold ~italic bold strikethrough ||italic bold strikethrough spoiler||~ __underline italic bold___ bold*
```

---

## Response Template

```
[1-sentence answer]

🎯 **Section 1**
Content here

📋 **Section 2**
• Bullet point 1
• Bullet point 2

```language
code block
```

✅ **Next Steps**
1. Step one
2. Step two
```

---

## Common Mistakes

❌ **Don't do this:**
```
Here's the code: def hello(): print("hi")
```

✅ **Do this:**
````
Here's the code:

```python
def hello():
    print("hi")
```
````

---

❌ **Don't do this:**
```
The result is: variable_name (without escaping in MarkdownV2)
```

✅ **Do this (MarkdownV2):**
```
The result is: variable\_name
```

✅ **Or use HTML:**
```html
The result is: <code>variable_name</code>
```

---

## Emoji Usage

**Good:**
```
🎯 **Goal:** Increase conversions by 20%
✅ Task completed
❌ Error: File not found
```

**Bad:**
```
🎉😎🔥 Congratulations! 🎊🪄🥳
```

**Rule:** 1-2 emoji per section max.

---

## Testing

Send this message to test formatting:

**HTML:**
```html
<b>Bold</b>, <i>italic</i>, <code>code</code>

<b>🎯 Section</b>
• Item 1
• Item 2

<pre><code class="language-python">
print("test")
</code></pre>
```

**MarkdownV2:**
```
*Bold*, _italic_, `code`

*🎯 Section*
• Item 1
• Item 2

```python
print("test")
```
```

If it works ✅ — formatting is correct.
If it breaks ❌ — check escaping/parse mode.
