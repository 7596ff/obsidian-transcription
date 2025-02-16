import { ChildProcess } from "child_process";
import {
	App,
	Editor,
	MarkdownView,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	Notice,
} from "obsidian";
import { TranscriptionEngine, TranscriptionSegment } from "src/transcribe";

interface TranscriptionSettings {
	timestamps: boolean;
	transcribeFileExtensions: string;
	whisperASRUrl: string;
	debug: boolean;
}

const DEFAULT_SETTINGS: TranscriptionSettings = {
	timestamps: false,
	transcribeFileExtensions: "mp3,wav,webm",
	whisperASRUrl: "http://localhost:9000",
	debug: false,
};

export default class Transcription extends Plugin {
	settings: TranscriptionSettings;
	public static plugin: Plugin;
	public static children: Array<ChildProcess> = [];
	public transcription_engine: TranscriptionEngine;

	debug(message: string) {
		if (this.settings.debug) {
			console.log(message);
		}
	}

	async onload() {
		await this.loadSettings();

		Transcription.plugin = this;

		this.debug("Loading Obsidian Transcription");

		this.transcription_engine = new TranscriptionEngine(
			this.settings,
			this.app.vault,
			TranscriptionEngine.prototype.getTranscriptionWhisperASR
		);

		this.addCommand({
			id: "obsidian-transcription-transcribe-all-in-view",
			name: "Transcribe all audio files in view",
			editorCallback: async (editor: Editor, view: MarkdownView) => {
				// Get the current filepath
				const markdownFilePath = view.file.path;

				this.debug(
					"Transcribing all audio files in " + markdownFilePath
				);

				new Notice(
					"Transcribing all audio files in " + view.file.name,
					3000
				);

				// Get all linked files in the markdown file
				const filesLinked = Object.keys(
					this.app.metadataCache.resolvedLinks[markdownFilePath]
				);

				// Now that we have all the files linked in the markdown file,
				// we need to filter them by the file extensions we want to
				// transcribe
				const filesToTranscribe: TFile[] = [];
				for (const linkedFilePath of filesLinked) {
					const linkedFileExtension = linkedFilePath.split(".").pop();
					if (
						linkedFileExtension === undefined ||
						!this.settings.transcribeFileExtensions
							.split(",")
							.includes(linkedFileExtension)
					) {
						this.debug(
							`Skipping ${linkedFilePath} because the file extension is not in the list of transcribable file extensions`
						);

						continue;
					}

					// We now know that the file extension is in the list of
					// transcribable file extensions
					const linkedFile =
						this.app.vault.getAbstractFileByPath(linkedFilePath);

					// Validate that we are dealing with a file and add it to
					// the list of verified files to transcribe
					if (linkedFile instanceof TFile) {
						filesToTranscribe.push(linkedFile);
					} else {
						this.debug("Could not find file " + linkedFilePath);

						continue;
					}
				}

				// Now that we have all the files to transcribe, we can
				// transcribe them
				for (const fileToTranscribe of filesToTranscribe) {
					this.debug("Transcribing " + fileToTranscribe.path);

					this.transcription_engine
						.getTranscription(fileToTranscribe)
						.then(async (transcription) => {
							this.debug(transcription.toString());

							let fileText = await this.app.vault.read(view.file);

							// This is the string that is used to link the audio
							// file in the markdown file. If files are moved
							// this potentially breaks, but Obsidian has
							// built-in handlers for this, and handling that is
							// outside the scope of this plugin
							const fileLinkString =
								this.app.metadataCache.fileToLinktext(
									fileToTranscribe,
									view.file.path
								);

							// This is the string that is used to link the audio
							// file in the markdown file.
							const fileLinkStringTagged = `[[${fileLinkString}]]`;
							this.debug(fileLinkString);

							// Perform a string replacement, add the
							// transcription to the next line after the file
							// link
							const startReplacementIndex =
								fileText.indexOf(fileLinkStringTagged) +
								fileLinkStringTagged.length;

							// instead of inserting the entire JSON response,
							// insert newline-delineated segments of text
							const segments = transcription.segments
								.map((segment: TranscriptionSegment) =>
									segment.text.trim()
								)
								.join("\n");

							// fileText = [fileText.slice(0, startReplacementIndex), `\n\`\`\`${transcription}\`\`\``, fileText.slice(startReplacementIndex)].join('');
							fileText = [
								fileText.slice(0, startReplacementIndex),
								`\n${segments}`,
								fileText.slice(startReplacementIndex),
							].join("");

							// Now that we have the file lines with the
							// transcription, we can write the file
							await this.app.vault.modify(view.file, fileText);

							// also output the result next to the file as json
							const encoder = new TextEncoder();
							const fileLinkStringJson = `${fileLinkString
								.split(".")
								.pop()}.json`;

							await this.app.vault.createBinary(
								`${fileToTranscribe.parent.path}/${fileLinkStringJson}`,
								encoder.encode(JSON.stringify(transcription))
							);
						})
						.catch((error) => {
							if (this.settings.debug)
								new Notice(
									"Error transcribing file " +
										fileToTranscribe.name +
										": " +
										error
								);
							else
								new Notice(
									"Error transcribing file, enable debug mode to see more"
								);
						});
				}
			},
		});

		// Kill child processes when the plugin is unloaded
		this.app.workspace.on("quit", () => {
			Transcription.children.forEach((child) => {
				child.kill();
			});
		});

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new TranscriptionSettingTab(this.app, this));
	}

	onunload() {
		if (this.settings.debug)
			console.log("Unloading Obsidian Transcription");
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class TranscriptionSettingTab extends PluginSettingTab {
	plugin: Transcription;

	constructor(app: App, plugin: Transcription) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		containerEl.createEl("h2", {
			text: "Settings for Obsidian Transcription",
		});

		new Setting(containerEl)
			.setName("Enable timestamps")
			.setDesc("Add timestamps to the beginning of each line")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.timestamps)
					.onChange(async (value) => {
						this.plugin.settings.timestamps = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Whisper ASR URL")
			.setDesc(
				"The URL of the Whisper ASR server: https://github.com/ahmetoner/whisper-asr-webservice"
			)
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.whisperASRUrl)
					.setValue(this.plugin.settings.whisperASRUrl)
					.onChange(async (value) => {
						this.plugin.settings.whisperASRUrl = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Allowed file extensions")
			.setDesc("Comma-separated list of file extensions to transcribe")
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.transcribeFileExtensions)
					.setValue(this.plugin.settings.transcribeFileExtensions)
					.onChange(async (value) => {
						this.plugin.settings.transcribeFileExtensions = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Debug mode")
			.setDesc("Enable debug mode to see more console logs")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.debug)
					.onChange(async (value) => {
						this.plugin.settings.debug = value;
						await this.plugin.saveSettings();
					})
			);
	}
}

export type { TranscriptionSettings };
