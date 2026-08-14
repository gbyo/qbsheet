# Writing rules for this wiki

This wiki uses ASD-STE100 Simplified Technical English. A scorekeeper reads these pages in a loud room,
under time pressure, and sometimes not in a first language. Simple English is the point.

Follow these rules when you edit a page.

## Sentences

1. Write no more than 20 words in an instruction.
2. Write no more than 25 words in a description.
3. Write one instruction in one sentence.
4. Write in the active voice. Say *Select the file*, not *The file must be selected*.
5. Use the imperative for a step. Say *Type the address*.
6. Use a simple tense: the simple present, the simple past, or the simple future.

## Words

1. Use one word for one meaning. Do not use *follow* for both *obey* and *come after*.
2. Use the same word for the same thing on every page. The [Glossary](Glossary) holds the list.
3. Use an article. Write *the room token*, not *room token*.
4. Do not use more than three nouns together. Write *the address of the tournament control server*.
5. Prefer the short word.

| Do not write | Write |
| --- | --- |
| in order to | to |
| prior to | before |
| utilise | use |
| ensure | make sure |
| perform | do |
| require | need |
| provide | give |
| additional | more |
| sufficient | enough |
| terminate | stop, or end |
| initiate | start |
| approximately | about |
| however | but |
| via | with, or through |
| e.g. | for example |
| i.e. | that is |

## Verbs and forms to avoid

1. Do not use an *-ing* verb form as the name of a thing. Write *Score a game*, not *Scoring a game*.
   An established technical name is an exception, for example *a pairing code*.
2. Do not use a participial phrase. Write *Select the file, then read the list*, not *Selecting the
   file, read the list*.
3. Do not use a contraction. Write *do not*, not *don't*.

## Requirement words

| Word | Use |
| --- | --- |
| must | A mandatory action |
| must not, do not | A prohibited action |
| can | A possibility, or a permission |

Do not use *may*, *might*, or *should* in an instruction. They are unclear.

The specifications in `docs/` follow these rules too. They also keep the uppercase key words MUST,
MUST NOT, SHOULD, SHOULD NOT, and MAY, and each document declares those key words as defined terms.
Other software implements those documents, so the conformance words stay.

Do not change an uppercase key word in `docs/` while you edit for style. A change from MUST to SHOULD,
or from a plain sentence to a MUST, changes what an implementer has to build.

## Structure

1. Give each page one purpose. Say that purpose in the first two sentences.
2. Use a numbered list for a sequence. Use a bullet list for a set.
3. Use a table for a set of paired facts.
4. Write no more than six sentences in a paragraph. Three is better.
5. Put a warning before the step that needs it, never after.
6. End each page with a **Related pages** list.

## Warnings

Use two levels only:

- **Caution:** a wrong action can lose data or a game.
- **Important:** a fact that changes what a reader must do.

## Names of things in the interface

Write an interface label in bold, with the exact text from the screen. For example:
select **Download QBJ backup**.

Write a file name, a command, a header, and a field name in code style. For example:
`x-yf-room-token`.

## What to check before you save an edit

1. Read each sentence. Count the words in any sentence that looks long.
2. Find every *-ing* word. Replace the ones that name a thing.
3. Find every passive sentence. Turn it around.
4. Check each new term against the [Glossary](Glossary). Add the term if it is missing.
5. Check that no page tells a reader to paste a token or a pairing code anywhere.

## Note on the approved word list

ASD-STE100 includes a dictionary of approved words. The dictionary is part of the licensed
specification, and this wiki does not reproduce it. These pages apply the writing rules and the common
substitutions above. A word choice can still need a correction against the licensed dictionary.

## Related pages

- [Glossary](Glossary)
- [Develop and contribute](Develop-and-contribute)
- [Home](Home)
