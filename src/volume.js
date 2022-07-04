import coolwarm from "./colormaps/cool-warm-paraview.png";
import plasma from "./colormaps/matplotlib-plasma.png";
import virdis from "./colormaps/matplotlib-virdis.png";
import rainbow from "./colormaps/rainbow.png";
import samselGreen from "./colormaps/samsel-linear-green.png";
import samselYgb from "./colormaps/samsel-linear-ygb-1211g.png";

export const volumes = {
    "Fuel": "7d87jcsh0qodk78/fuel_64x64x64_uint8.raw",
    "Neghip": "zgocya7h33nltu9/neghip_64x64x64_uint8.raw",
    "Hydrogen Atom": "jwbav8s3wmmxd5x/hydrogen_atom_128x128x128_uint8.raw",
    "Boston Teapot": "w4y88hlf2nbduiv/boston_teapot_256x256x178_uint8.raw",
    "Engine": "ld2sqwwd3vaq4zf/engine_256x256x128_uint8.raw",
    "Bonsai": "rdnhdxmxtfxe0sa/bonsai_256x256x256_uint8.raw",
    "Foot": "ic0mik3qv4vqacm/foot_256x256x256_uint8.raw",
    "Skull": "5rfjobn0lvb7tmo/skull_256x256x256_uint8.raw",
    "Aneurysm": "3ykigaiym8uiwbp/aneurism_256x256x256_uint8.raw",
};

export const colormaps = {
    "Cool Warm": coolwarm,
    "Matplotlib Plasma": plasma,
    "Matplotlib Virdis": virdis,
    "Rainbow": rainbow,
    "Samsel Linear Green": samselGreen,
    "Samsel Linear YGB 1211G": samselYgb,
};

export function getVolumeDimensions(file)
{
    var fileRegex = /.*\/(\w+)_(\d+)x(\d+)x(\d+)_(\w+)\.*/;
    var m = file.match(fileRegex);
    return [parseInt(m[2]), parseInt(m[3]), parseInt(m[4])];
}

export function getCubeMesh()
{
    var cubeVertices = [
        1, 1, 0, 0, 1, 0, 1, 1, 1, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0, 0,
        1, 1, 0, 1, 0, 0, 1, 1, 1, 1, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 0
    ];
    // Indices are required to render a triangle strip, but ours here are trivial
    var cubeIndices = [];
    for (var i = 0; i < cubeVertices.length; ++i) {
        cubeIndices.push(i);
    }
    return {vertices: cubeVertices, indices: cubeIndices};
}

export function alignTo(val, align)
{
    return Math.floor((val + align - 1) / align) * align;
};

function padVolume(buf, volumeDims)
{
    const paddedVolumeDims = [alignTo(volumeDims[0], 256), volumeDims[1], volumeDims[2]];
    var padded =
        new Uint8Array(paddedVolumeDims[0] * paddedVolumeDims[1] * paddedVolumeDims[2]);
    // Copy each row into the padded volume buffer
    const nrows = volumeDims[1] * volumeDims[2];
    for (var i = 0; i < nrows; ++i) {
        var inrow = buf.subarray(i * volumeDims[0], i * volumeDims[0] + volumeDims[0]);
        padded.set(inrow, i * paddedVolumeDims[0]);
    }
    return padded;
}

export async function fetchVolume(file)
{
    const volumeDims = getVolumeDimensions(file);
    const volumeSize = volumeDims[0] * volumeDims[1] * volumeDims[2];

    var loadingProgressText = document.getElementById("loadingText");
    var loadingProgressBar = document.getElementById("loadingProgressBar");
    loadingProgressText.innerHTML = "Loading Volume...";
    loadingProgressBar.setAttribute("style", "width: 0%");

    var url = "https://www.dl.dropboxusercontent.com/s/" + file + "?dl=1";
    try {
        var response = await fetch(url);
        var reader = response.body.getReader();

        var receivedSize = 0;
        var buf = new Uint8Array(volumeSize);
        while (true) {
            var {done, value} = await reader.read();
            if (done) {
                break;
            }
            buf.set(value, receivedSize);
            receivedSize += value.length;
            var percentLoaded = receivedSize / volumeSize * 100;
            loadingProgressBar.setAttribute("style", `width: ${percentLoaded.toFixed(2)}%`);
        }
        loadingProgressText.innerHTML = "Volume Loaded";

        // WebGPU requires that bytes per row = 256, so we need to pad volumes
        // that are smaller than this
        if (volumeDims[0] % 256 != 0) {
            return padVolume(buf, volumeDims);
        }
        return buf;
    } catch (err) {
        console.log(`Error loading volume: ${err}`);
        loadingProgressText.innerHTML = "Error loading volume";
    }
    return null;
}

export async function uploadVolume(device, volumeDims, volumeData)
{
    var volumeTexture = device.createTexture({
        size: volumeDims,
        format: "r8unorm",
        dimension: "3d",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
    });

    var uploadBuf = device.createBuffer(
        {size: volumeData.length, usage: GPUBufferUsage.COPY_SRC, mappedAtCreation: true});
    new Uint8Array(uploadBuf.getMappedRange()).set(volumeData);
    uploadBuf.unmap();

    var commandEncoder = device.createCommandEncoder();

    var src = {
        buffer: uploadBuf,
        // Volumes must be aligned to 256 bytes per row, fetchVolume does this padding
        bytesPerRow: alignTo(volumeDims[0], 256),
        rowsPerImage: volumeDims[1]
    };
    var dst = {texture: volumeTexture};
    commandEncoder.copyBufferToTexture(src, dst, volumeDims);

    device.queue.submit([commandEncoder.finish()]);
    await device.queue.onSubmittedWorkDone();

    return volumeTexture;
}

export async function uploadImage(device, imageSrc)
{
    var image = new Image();
    image.src = imageSrc;
    await image.decode();
    var bitmap = await createImageBitmap(image);

    var texture = device.createTexture({
        size: [bitmap.width, bitmap.height, 1],
        format: "rgba8unorm",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST |
                   GPUTextureUsage.RENDER_ATTACHMENT
    });

    var src = {source: bitmap};
    var dst = {texture: texture};
    device.queue.copyExternalImageToTexture(src, dst, [bitmap.width, bitmap.height]);
    await device.queue.onSubmittedWorkDone();

    return texture;
}

export function linearToSRGB(x)
{
    if (x <= 0.0031308) {
        return 12.92 * x;
    }
    return 1.055 * Math.pow(x, 1.0 / 2.4) - 0.055;
}

export function fillSelector(selector, dict)
{
    for (var v in dict) {
        var opt = document.createElement("option");
        opt.value = v;
        opt.innerHTML = v;
        selector.appendChild(opt);
    }
}
