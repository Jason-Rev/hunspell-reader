#!/usr/bin/env node

// cSpell:ignore findup
import * as commander from 'commander';
import { IterableHunspellReader } from './IterableHunspellReader';
import * as fs from 'fs-extra';
import { uniqueFilter, batch } from './util';
import { genSequence, Sequence } from 'gensequence';
import { AffWord, asAffWord } from './aff';
import { iterableToStream } from './iterableToStream';

const uniqueHistorySize = 500000;

const packageInfo = require('../package.json');
const version = packageInfo['version'];

let displayHelp = true;
let logStream = process.stderr;

commander
    .version(version);

commander
    .command('words <hunspell_dic_file>')
    .option('-o, --output <file>', 'output file - defaults to stdout')
    .option('-s, --sort', 'sort the list of words')
    .option('-u, --unique', 'make sure the words are unique.')
    .option('-l, --lower_case', 'output in lower case')
    .option('-T, --no-transform', 'Do not apply the prefix and suffix transforms.  Root words only.')
    .option('-x, --infix', 'Return words with prefix / suffix breaks. ex: "un<do>ing"')
    .option('-r, --rules', 'Append rules used to generate word.')
    .option('-p, --progress', 'Show progress.')
    .description('Output all the words in the <hunspell.dic> file.')
    .action(action);

commander.parse(process.argv);

if (displayHelp) {
    commander.help();
}

function notify(message: string, newLine = true) {
    message = message + (newLine ? '\n' : '');
    logStream.write(message, 'utf-8');
}

function yesNo(value: boolean) {
    return value ? 'Yes' : 'No';
}

function affWordToInfix(aff: AffWord): AffWord {
    return { ...aff, word: aff.prefix + '<' + aff.base + '>' + aff.suffix };
}

function mapWord(map: (word: string) => string): (aff: AffWord) => AffWord {
    return (aff: AffWord) => ({ ...aff, word: map(aff.word) });
}

function appendRules(aff: AffWord): AffWord {
    return { ...aff, word: aff.word + '\t[' + aff.rulesApplied + ' ]\t' + '(' + aff.dic + ')' };
}

function writeSeqToFile(seq: Sequence<string>, outFile: string | undefined): Promise<void> {
    return new Promise((resolve, reject)  => {
        let resolved = false;
        const out = outFile ? fs.createWriteStream(outFile) : process.stdout;
        const bufferedSeq = genSequence(batch(seq, 500)).map(batch => batch.join(''));
        const dataStream = iterableToStream(bufferedSeq);
        const fileStream = dataStream.pipe(out);
        const endEvents = ['finish', 'close', 'end'];

        function resolvePromise() {
            console.error('resolvePromise');
            if (!resolved) {
                resolved = true;
                resolve();
            }
        }
        const endHandler = () => {
            console.error('endHandler');
            cleanupStreams();
            setTimeout(resolvePromise, 10);
        };
        const errorHandler = (e: Error) => {
            console.error('errorHandler');
            cleanupStreams();
            reject(e);
        };

        listenToStreams();

        function listenToStreams() {
            endEvents.forEach(event => (fileStream.addListener(event, endHandler), console.error(`addListener ${event}`)));
            fileStream.addListener('error', errorHandler);
            dataStream.addListener('end', endHandler);
        }

        function cleanupStreams() {
            console.error('cleanupStream');
            endEvents.forEach(event => fileStream.removeListener(event, endHandler));
            fileStream.removeListener('error', errorHandler);
            dataStream.removeListener('end', endHandler);
        }
    });
}

function action(hunspellDicFilename: string, options: any): Promise<void> {
    return actionPrime(hunspellDicFilename, options).catch((reason: { code: string }) => {
        if (reason.code === 'EPIPE') {
            return;
        }
        console.error(reason);
    });
}

interface Options {
    sort?: boolean;
    unique?: boolean;
    lower_case?: boolean;
    output?: string;
    transform?: boolean;
    infix?: boolean;
    rules?: boolean;
    progress?: boolean;
}

async function actionPrime(hunspellDicFilename: string, options: Options) {
    displayHelp = false;
    const {
        sort = false,
        unique = false,
        output: outputFile,
        lower_case: lowerCase = false,
        transform = true,
        infix = false,
        rules = false,
        progress: showProgress = false,
    } = options;
    logStream = outputFile ? process.stdout : process.stderr;
    const log = notify;
    log('Write words');
    log(`Sort: ${yesNo(sort)}`);
    log(`Unique: ${yesNo(unique)}`);
    const baseFile = hunspellDicFilename.replace(/\.(dic|aff)$/, '');
    const dicFile = baseFile + '.dic';
    const affFile = baseFile + '.aff';
    log(`Dic file: ${dicFile}`);
    log(`Aff file: ${affFile}`);
    log(`Generating Words...`);
    const reader = await IterableHunspellReader.createFromFiles(affFile, dicFile);
    const transformers: ((_: AffWord) => AffWord)[] = [];
    if (infix) { transformers.push(affWordToInfix); }
    if (lowerCase) { transformers.push(mapWord(a => a.toLowerCase())); }
    if (rules) { transformers.push(appendRules); }
    transformers.push(mapWord(a => a.trim()));
    const dicSize = reader.dic.length;
    let current = 0;
    const calcProgress = () => '\r' + current + ' / ' + dicSize;
    const reportProgressRate = 253;
    const callback = showProgress
    ? () => {
            current++;
            !(current % reportProgressRate) && process.stderr.write(calcProgress(), 'UTF-8');
        }
    : () => {};
    const seqWords = transform ? reader.seqAffWords(callback) : reader.seqRootWords().map(asAffWord);
    const filterUnique = unique ? uniqueFilter(uniqueHistorySize, (aff: AffWord) => aff.word) : (_: AffWord) => true;

    const applyTransformers = (aff: AffWord) => transformers.reduce((aff, fn) => fn(aff), aff);

    const words = seqWords
        .map(applyTransformers)
        .filter(filterUnique)
        .filter(a => !!a.word)
        .map(a => a.word + '\n')
        ;

    if (sort) {
        log('Sorting...');
        const data = words.toArray().sort().join('');
        const fd = outputFile ? fs.openSync(outputFile, 'w') : 1;
        fs.writeSync(fd, data);
    } else {
        await writeSeqToFile(words, outputFile);
    }
    if (showProgress) { console.error(calcProgress()); }
    log('Done.');
}
