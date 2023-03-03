import { TranscriptionSettings } from "src/main";
import {
	getBlobArrayBuffer,
	requestUrl,
	RequestUrlParam,
	TFile,
	Vault,
} from "obsidian";
import { randomString } from "src/utils";

export interface TranscriptionSegment {
	id: number;
	seek: number;
	start: number;
	end: number;
	text: string;
	tokens: number[];
	temperature: number;
	avg_logprob: number;
	compression_ratio: number;
	no_speech_prob: number;
}

export interface TranscriptionResult {
	text: string;
	segments: TranscriptionSegment[];
	language: string;
}

// This class is the parent for transcription engines. It takes settings and a
// file as an input and returns a transcription as a string
export class TranscriptionEngine {
	settings: TranscriptionSettings;
	vault: Vault;
	transcription_engine: (file: TFile) => Promise<TranscriptionResult>;

	constructor(
		settings: TranscriptionSettings,
		vault: Vault,
		transcription_engine: (file: TFile) => Promise<TranscriptionResult>
	) {
		this.settings = settings;
		this.vault = vault;
		this.transcription_engine = transcription_engine;
	}

	debug(message: string) {
		if (this.settings.debug) {
			console.log(message);
		}
	}

	/**
	 *
	 * @param {TFile} file
	 * @returns {Promise<string>} promise that resolves to a string containing the transcription
	 */
	async getTranscription(file: TFile): Promise<TranscriptionResult> {
		return this.transcription_engine(file);
	}

	async getTranscriptionWhisperASR(
		file: TFile
	): Promise<TranscriptionResult> {
		// This next block is a workaround to current Obsidian API limitations:
		// requestURL only supports string data or an unnamed blob, not
		// key-value formdata
		//
		// Essentially what we're doing here is constructing a
		// multipart/form-data payload manually as a string and then passing it
		// to requestURL
		//
		// I believe this to be equivalent to the following curl command: curl
		// --location --request POST
		// 'http://localhost:9000/asr?task=transcribe&language=en' --form
		// 'audio_file=@"test-vault/02 Files/Recording.webm"'

		// Generate the form data payload Boundary string, it can be arbitrary,
		// I'm just using a random string here
		//
		// https://stackoverflow.com/questions/3508338/what-is-the-boundary-in-multipart-form-data
		// https://stackoverflow.com/questions/1349404/generate-random-string-characters-in-javascript
		const randomBoundaryString = "Boundary" + randomString(16); // Prefix + 16 char random Boundary string

		// Construct the form data payload as a string
		const pre_string = `------${randomBoundaryString}\r\nContent-Disposition: form-data; name="audio_file"; filename="blob"\r\nContent-Type: "application/octet-stream"\r\n\r\n`;
		const post_string = `\r\n------${randomBoundaryString}--`;

		// Convert the form data payload to a blob by concatenating the
		// pre_string, the file data, and the post_string, and then return the
		// blob as an array buffer
		const pre_string_encoded = new TextEncoder().encode(pre_string);

		// const data = new Blob([await this.app.vault.adapter.readBinary(fileToTranscribe.path)]);
		const data = new Blob([await this.vault.readBinary(file)]);
		const post_string_encoded = new TextEncoder().encode(post_string);
		const concatenated = await new Blob([
			pre_string_encoded,
			await getBlobArrayBuffer(data),
			post_string_encoded,
		]).arrayBuffer();

		// Now that we have the form data payload as an array buffer, we can
		// pass it to requestURL
		//
		// We also need to set the content type to multipart/form-data and pass
		// in the Boundary string
		const options: RequestUrlParam = {
			method: "POST",
			url: `${this.settings.whisperASRUrl}/asr?task=transcribe&language=en&output=json`,
			contentType: `multipart/form-data; boundary=----${randomBoundaryString}`,
			body: concatenated,
		};

		this.debug("Transcribing with WhisperASR");
		return requestUrl(options)
			.then(async (response) => {
				this.debug(response.toString());

				return response.json;
			})
			.catch((error) => {
				if (this.settings.debug) console.error(error);
				return Promise.reject(error);
			});
	}
}
