# Edge Case: Formatting Stress Test

## Adjacent formatting

**bold***italic*

**bold** *italic*

`code`**bold**`code`

~~strike~~**bold**~~strike~~

## Formatting at line boundaries

**bold at start** of line

Text with **bold at end**

*italic at start* of line

Text with *italic at end*

`code at start` of line

Text with `code at end`

## Overlapping-like patterns (should NOT overlap)

**outer **inner** outer** — this is ambiguous markdown

*outer *inner* outer* — also ambiguous

## Empty formatting

****

****

~~

## Single character

**a**

*b*

`c`

~~d~~

## Formatting with special characters

**Hello, 世界！**

*Price: ¥100*

`var x = 1 + 2;`

~~Deleted: score=0.95~~

## Long content

**This is a very long bold text that spans across what would normally be multiple lines in a typical editor window, testing whether the bold decoration properly wraps and continues to apply across line breaks**

*This is a very long italic text that spans across what would normally be multiple lines in a typical editor window, testing whether the italic decoration properly wraps and continues to apply across line breaks*

`This is a very long inline code that spans across what would normally be multiple lines in a typical editor window, testing whether the inline code decoration properly wraps and continues to apply across line breaks`

## Multiple formatting on same line

Line with **bold1** and **bold2** and **bold3** all together.

Line with *italic1* and *italic2* and *italic3* all together.

Line with `code1` and `code2` and `code3` all together.

## Deeply nested

***Bold-italic with `code` inside***

**Bold with *italic with `code` inside* bold**

> Blockquote with **bold with `code` inside** text
