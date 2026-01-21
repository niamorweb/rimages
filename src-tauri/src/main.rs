/*
 * Copyright (C) 2026  Romain Lathuiliere
 * * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */
 
 
 #![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::io::Cursor;
use std::process::Command; 
use image::imageops::FilterType;
use image::ImageFormat;
use tauri::{AppHandle, Emitter};
use rgb::FromSlice; 

#[derive(Debug, Deserialize)]
struct CompressConfig {
    paths: Vec<String>,
    output_dir: String,
    format: String,
    quality: u8,
    max_width: Option<u32>,
    max_height: Option<u32>,
    _prefix: Option<String>,
    _suffix: Option<String>,
    _custom_names: Option<HashMap<String, String>>,
}

#[derive(Debug, Serialize, Clone)]
struct ProcessResult {
    original: String,
    status: String,
    error_msg: Option<String>,
    new_path: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
struct PreviewResult {
    path: String,
    original_size: u64,
    preview_size: u64,
}

fn get_image_format(fmt: &str) -> ImageFormat {
    match fmt {
        "jpg" | "jpeg" => ImageFormat::Jpeg,
        "png" => ImageFormat::Png,
        "webp" => ImageFormat::WebP,
        "avif" => ImageFormat::Avif,
        _ => ImageFormat::Jpeg,
    }
}

// --- ENCODEURS SPÉCIAUX ---

fn encode_webp(img: &image::DynamicImage, quality: u8) -> Result<Vec<u8>, String> {
    let encoder = match webp::Encoder::from_image(img) {
        Ok(enc) => enc,
        Err(_) => return Err("Erreur init WebP".to_string()),
    };
    let memory = encoder.encode(quality as f32);
    Ok(memory.to_vec())
}

fn encode_avif(img: &image::DynamicImage, quality: u8) -> Result<Vec<u8>, String> {
    let rgba_img = img.to_rgba8();
    let width = rgba_img.width();
    let height = rgba_img.height();
    let raw_pixels = rgba_img.as_raw();
    
    // speed(4) = Bon compromis vitesse/taille
    let src_img = imgref::Img::new(raw_pixels.as_rgba(), width as usize, height as usize);
    let enc = ravif::Encoder::new()
        .with_quality(quality as f32)
        .with_speed(4)
        .encode_rgba(src_img);

    match enc {
        Ok(encoded) => Ok(encoded.avif_file),
        Err(e) => Err(format!("Erreur AVIF: {}", e)),
    }
}

// LA MAGIE PNG (Quantification)
fn encode_png(img: &image::DynamicImage, quality: u8) -> Result<Vec<u8>, String> {
    let rgba = img.to_rgba8();
    let width = rgba.width();
    let height = rgba.height();
    let raw_pixels = rgba.as_raw();

    // 1. Configurer imagequant (Liq)
    let mut attr = imagequant::Attributes::new();
    // Le slider qualité (0-100) contrôle l'agressivité de la réduction de couleurs
    let min_q = std::cmp::max(0, quality.saturating_sub(20)); // Plage dynamique
    attr.set_quality(min_q, quality).map_err(|e| format!("Liq config: {:?}", e))?;
    
    // 2. Créer l'image pour Liq
    // Note: imagequant demande des références, on utilise as_rgba()
    let mut img_liq = attr.new_image(raw_pixels.as_rgba(), width as usize, height as usize, 0.0)
        .map_err(|e| format!("Liq image: {:?}", e))?;

    // 3. Quantifier (Calculer la palette)
    let mut res = attr.quantize(&mut img_liq)
        .map_err(|e| format!("Liq quantize: {:?}", e))?;
    
    // 4. Appliquer la palette (Remapping)
    let (palette, pixels) = res.remapped(&mut img_liq)
        .map_err(|e| format!("Liq remap: {:?}", e))?;

    // 5. Écrire le PNG final (Format Indexé)
    let mut buffer = Vec::new();
    let mut encoder = png::Encoder::new(&mut buffer, width, height);
    
    encoder.set_color(png::ColorType::Indexed);
    encoder.set_depth(png::BitDepth::Eight);
    
    // Conversion de la palette imagequant -> format attendu par png crate
    let palette_vec: Vec<u8> = palette.iter().flat_map(|c| [c.r, c.g, c.b]).collect();
    // Si la palette a de la transparence, il faut gérer le chunk 'tRNS', mais pour faire simple ici
    // on passe juste la palette RGB. (La gestion alpha avancée en PNG indexé est complexe).
    // Note: Pour une transparence parfaite en PNG8, c'est plus complexe. 
    // Ici on fait du standard RGB palette.
    encoder.set_palette(&palette_vec);

    // Astuce: Si imagequant détecte de la transparence, il met les pixels transparents à un index spécifique.
    // Pour ce code "simple", on accepte que la transparence complexe soit parfois simplifiée.
    
    let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
    writer.write_image_data(&pixels).map_err(|e| e.to_string())?;
    writer.finish().map_err(|e| e.to_string())?;

    Ok(buffer)
}

// Fonction helper pour éviter d'écraser les fichiers existants
fn get_unique_path(mut path: std::path::PathBuf) -> std::path::PathBuf {
    let mut counter = 1;
    let original_stem = path.file_stem().unwrap().to_string_lossy().to_string();
    let extension = path.extension().unwrap().to_string_lossy().to_string();
    let parent = path.parent().unwrap().to_path_buf();

    // Tant que le fichier existe, on ajoute un numéro -1, -2, etc.
    while path.exists() {
        let new_name = format!("{}-{}.{}", original_stem, counter, extension);
        path = parent.join(new_name);
        counter += 1;
    }
    
    path
}


#[derive(Debug, Serialize)]
struct ImageMetadata {
    path: String,
    width: u32,
    height: u32,
    size: u64,
}

// AJOUTER CETTE COMMANDE
#[tauri::command]
async fn get_images_metadata(paths: Vec<String>) -> Vec<ImageMetadata> {
    // On utilise rayon ici aussi pour que ce soit instantané même avec 100 photos
    paths.par_iter().filter_map(|path_str| {
        let path = Path::new(path_str);
        // On lit juste les métadonnées sans charger toute l'image en RAM si possible
        // Note: image::image_dimensions est très rapide car il ne décode que le header
        let dims = image::image_dimensions(path).ok();
        let metadata = fs::metadata(path).ok()?;
        
        if let Some((w, h)) = dims {
            Some(ImageMetadata {
                path: path_str.clone(),
                width: w,
                height: h,
                size: metadata.len(),
            })
        } else {
            None
        }
    }).collect()
}

// --- COMMANDES ---


#[tauri::command]
async fn preview_images(app: AppHandle, config: CompressConfig) {
    let config = Arc::new(config);
    let app_handle = app.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let results: Vec<PreviewResult> = config.paths.par_iter().filter_map(|path_str| {
            let path = Path::new(path_str);
            let metadata = fs::metadata(path).ok()?;
            let original_disk_size = metadata.len();

            let img = image::open(path).ok()?;
            let (orig_w, orig_h) = (img.width(), img.height());

            // --- ESTIMATION ---
            let target_w = config.max_width.unwrap_or(u32::MAX);
            let target_h = config.max_height.unwrap_or(u32::MAX);
            
            let scale = (target_w as f64 / orig_w as f64).min(target_h as f64 / orig_h as f64).min(1.0);
            let final_w = (orig_w as f64 * scale) as u32;
            let final_h = (orig_h as f64 * scale) as u32;

            let proxy_size = 256; 
            let (proxy_img, ratio) = if final_w > proxy_size {
                let proxy = img.resize(proxy_size, proxy_size, FilterType::Triangle); 
                let area_final = (final_w * final_h) as f64;
                let area_proxy = (proxy.width() * proxy.height()) as f64;
                (proxy, area_final / area_proxy)
            } else {
                (img.resize(final_w, final_h, FilterType::Triangle), 1.0)
            };

            // Compression Proxy
            let size_res: Option<u64> = match config.format.as_str() {
                "webp" => encode_webp(&proxy_img, config.quality).ok().map(|v| v.len() as u64),
                "avif" => encode_avif(&proxy_img, config.quality).ok().map(|v| v.len() as u64),
                "png"  => encode_png(&proxy_img, config.quality).ok().map(|v| v.len() as u64),
                "jpg" | "jpeg" => {
                    let mut buf = Cursor::new(Vec::with_capacity(50_000));
                    let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, config.quality);
                    enc.encode(proxy_img.as_bytes(), proxy_img.width(), proxy_img.height(), proxy_img.color().into()).ok()?;
                    Some(buf.get_ref().len() as u64)
                },
                _ => None // Fallback ignoré pour preview
            };

            if let Some(s) = size_res {
                Some(PreviewResult {
                    path: path_str.clone(),
                    original_size: original_disk_size,
                    preview_size: (s as f64 * ratio) as u64,
                })
            } else {
                None
            }
        }).collect();

        let _ = app_handle.emit("preview-done", results);
    });
}

#[tauri::command]
fn open_folder(path: String) {
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer").arg(path).spawn().unwrap();
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open").arg(path).spawn().unwrap();
    }
    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open").arg(path).spawn().unwrap();
    }
}

#[tauri::command]
async fn compress_images(app: AppHandle, config: CompressConfig) {
    let config = Arc::new(config);
    let app_handle = app.clone();

    let pool = rayon::ThreadPoolBuilder::new().num_threads(4).build().unwrap();

    let _ = tauri::async_runtime::spawn_blocking(move || {
        pool.install(|| {
            config.paths.par_iter().for_each(|path_str| {
                let _ = app_handle.emit("img-start", path_str);
                let path = Path::new(path_str);

                if let Ok(img) = image::open(path) {
                    let (w, h) = (img.width(), img.height());
                    let tw = config.max_width.unwrap_or(u32::MAX);
                    let th = config.max_height.unwrap_or(u32::MAX);
                    
                    let final_img = if w > tw || h > th {
                        img.resize(tw, th, FilterType::Lanczos3)
                    } else {
                        img
                    };

                    let stem = path.file_stem().unwrap().to_string_lossy();
                    let ext = if config.format == "jpeg" { "jpg" } else { &config.format };
                    
                    // 1. On construit le chemin théorique
                    let base_output_path = Path::new(&config.output_dir).join(format!("{}-compressed.{}", stem, ext));
                    
                    // 2. UX SECURITY : On vérifie s'il existe et on renomme si besoin
                    let output_path = get_unique_path(base_output_path);

                    let res = match config.format.as_str() {
                        "webp" => encode_webp(&final_img, config.quality).and_then(|d| fs::write(&output_path, d).map_err(|e| e.to_string())),
                        "avif" => encode_avif(&final_img, config.quality).and_then(|d| fs::write(&output_path, d).map_err(|e| e.to_string())),
                        "png"  => encode_png(&final_img, config.quality).and_then(|d| fs::write(&output_path, d).map_err(|e| e.to_string())),
                        "jpg" | "jpeg" => {
                            fs::File::create(&output_path).map_err(|e| e.to_string()).and_then(|f| {
                                let mut w = std::io::BufWriter::new(f);
                                image::codecs::jpeg::JpegEncoder::new_with_quality(&mut w, config.quality)
                                    .encode(final_img.as_bytes(), final_img.width(), final_img.height(), final_img.color().into())
                                    .map_err(|e| e.to_string())
                            })
                        },
                        _ => final_img.save_with_format(&output_path, get_image_format(&config.format)).map_err(|e| e.to_string())
                    };

                    let status_res = match res {
                        Ok(_) => ProcessResult { original: path_str.clone(), status: "success".to_string(), error_msg: None, new_path: Some(output_path.to_string_lossy().to_string()) },
                        Err(e) => ProcessResult { original: path_str.clone(), status: "error".to_string(), error_msg: Some(e), new_path: None }
                    };
                    let _ = app_handle.emit("img-processed", status_res);

                } else {
                    let _ = app_handle.emit("img-processed", ProcessResult {
                        original: path_str.clone(),
                        status: "error".to_string(),
                        error_msg: Some("Open failed".to_string()),
                        new_path: None
                    });
                }
            });
        });
        let _ = app_handle.emit("batch-finished", ()); 
    });
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init()) 
        .plugin(tauri_plugin_dialog::init()) 
        .plugin(tauri_plugin_fs::init()) 
        .invoke_handler(tauri::generate_handler![compress_images, preview_images, get_images_metadata, open_folder])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}